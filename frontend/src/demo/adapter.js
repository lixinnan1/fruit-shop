/**
 * 静态演示版的"后端"：只在 demo 模式（npm run build:demo）启用，由 src/api/index.js 挂成 axios 的 adapter。
 *
 * 演示版部署在 GitHub Pages，没有 Spring Boot、数据库和 Python，/api 请求全部在浏览器里回答：
 *  - 查询（GET）：回放 fixtures.json 里录下的真实响应。快照由 scripts/record_demo_fixtures.py 对着真实后端录制，
 *    营业日固定为种子数据最后一天（fixtures.meta.bizDate，与 utils/bizDate.js 一致）。
 *  - 提交（生成建议、确认价格、推送、登记销售/报废/到货）：按录下的响应模板拼出结果，并改动内存里的状态，
 *    让列表、看板跟着变。状态只在当前页面里，刷新就回到初始快照，不会写到任何地方。
 *  - 提交时照后端的规则校验：最低折扣线、同一单品每天最多调价 2 次、推送每人每天条数上限和静默时段；
 *    有店主确认价的单品，推送文案用确认价；登记的销售和报废按生效策略叠加到效果看板（只加在营业日那天）。
 *
 * 快照里没有的组合（比如把日期改成别的营业日）如实返回"演示版没有这份数据"，不编数据。
 * 改了后端接口或种子数据后，重新运行录制脚本即可，这里一般不用改。
 */
import fixtures from './fixtures.json'

const BIZ = fixtures.meta.bizDate
const STRATEGIES = ['FIXED', 'RULE', 'MODEL']
const MIN_DISCOUNT_RATE = 0.6 // 与后端 app.pricing.min-discount-rate 一致（录制时的配置）
const MAX_ADJUST_PER_DAY = 2 // 与后端 app.pricing.max-adjust-per-day 一致：生成一条建议、店主改一次价各算 1 次
const SEND_POLICY = fixtures.posts.send?.data || {}
const DAILY_PUSH_LIMIT = Number(SEND_POLICY.dailyLimitPerMember) || 2 // 每个会员每天最多收几条个人推送
const QUIET_HOURS = SEND_POLICY.quietHours || '22:00-08:00' // 静默时段，按计划发送时间判断
const LATENCY_MS = 150 // 留一点延迟，加载动画和按钮的 loading 状态才看得见

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
const round2 = (n) => Math.round(Number(n) * 100) / 100
const qty = (n) => String(round2(n))
const money = (n) => Number(n).toFixed(2)

/** 与 scripts/record_demo_fixtures.py 的 key() 一致：参数按名字排序，布尔写成 true/false，空值不算 */
function requestKey(path, params = {}) {
  const parts = Object.keys(params)
    .sort()
    .filter((name) => params[name] !== undefined && params[name] !== null)
    .map((name) => `${name}=${params[name]}`)
  return parts.length ? `${path}?${parts.join('&')}` : path
}

function recorded(path, params) {
  return fixtures.gets[requestKey(path, params)]
}

function shiftDate(date, days) {
  const [y, m, d] = String(date).split('-').map(Number)
  const t = new Date(y, m - 1, d + days)
  const pad = (n) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
}

/** 演示版的"现在"：日期是营业日，时刻取本机时间 */
function now() {
  return `${BIZ} ${new Date().toTimeString().slice(0, 8)}`
}

function discountLabel(rate) {
  const r = Number(rate)
  if (r >= 0.995) return '原价'
  return Number((r * 10).toFixed(1)) + '折'
}

const ok = (data) => ({ code: 0, message: 'ok', data })
const fail = (code, message) => ({ code, message, data: null })
const notInDemo = () =>
  fail(400, `演示版只有营业日 ${BIZ} 的数据（效果看板另有近 7、30、90 天，客流有近 14 天），请把日期改回来再看。`)

// ------------------------------------------------------------------ 内存里的状态（从快照复制一份）
const items = recorded('/items').data
const itemById = new Map(items.map((i) => [i.id, i]))

const state = {
  nearExpiry: clone(recorded('/batches/near-expiry', { bizDate: BIZ, days: fixtures.meta.nearExpiryMaxDays }).data),
  atRisk: clone(recorded('/batches/at-risk', { bizDate: BIZ }).data),
  onSale: clone(recorded('/batches/on-sale', { bizDate: BIZ }).data),
  inStock: new Map(),
  suggestions: {},
  generated: [], // 已生成过建议的策略，按生成先后
  taskLogs: new Map(), // taskId → 逐条发送记录（录下的计划 + 演示中新发的）
  newTasks: [], // 演示中预览/发送的计划
  openedInDemo: new Map(), // 录下的计划里，演示中新标记打开的条数：taskId → 条数
  feedbackByRequestNo: new Map(),
  priceChanges: new Map(), // itemId → 当天店主改价（最终价 ≠ 建议价）的次数，计入每日调价上限
  statDelta: new Map(), // strategy → 演示中登记的销售、报废带来的增量，叠加到效果看板上
  nextId: { decision: 0, task: 0, log: 0, sale: 0, batch: 0 }
}

for (const [key, body] of Object.entries(fixtures.gets)) {
  if (key.startsWith('/batches/in-stock?')) state.inStock.set(key, clone(body.data))
  if (key.startsWith('/push/tasks?')) {
    for (const task of body.data || []) state.taskLogs.set(task.taskId, clone(task.logs || []))
  }
}
for (const s of STRATEGIES) {
  state.suggestions[s] = clone(recorded('/pricing/suggestions', { bizDate: BIZ, strategy: s }).data)
  if (state.suggestions[s].length) state.generated.push(s)
}

const allSuggestions = () => STRATEGIES.flatMap((s) => state.suggestions[s])
const maxOf = (values) => values.reduce((m, v) => Math.max(m, Number(v) || 0), 0)

// 录下的决策里已经改过价的，也要算进当天的调价次数
for (const row of allSuggestions()) {
  if (row.decided && row.finalPrice != null && Math.abs(Number(row.finalPrice) - Number(row.suggestedPrice)) >= 0.005) {
    state.priceChanges.set(row.itemId, (state.priceChanges.get(row.itemId) || 0) + 1)
  }
}

/** 与后端 PricingAdjustGuard 一致：当天该单品的建议条数（不分策略）+ 店主改价次数 */
function adjustCount(itemId) {
  return allSuggestions().filter((r) => r.itemId === itemId).length + (state.priceChanges.get(itemId) || 0)
}

function adjustLimitReason(itemName) {
  return `单品 ${itemName} 在 ${BIZ} 已经调价 ${MAX_ADJUST_PER_DAY} 次，达到「同一单品每天最多调价 ${MAX_ADJUST_PER_DAY} 次」` +
    `的上限（app.pricing.max-adjust-per-day）；第 ${MAX_ADJUST_PER_DAY + 1} 次调价被拒绝，请明天再调。`
}

/** 演示中的销售、报废按策略累加，口径与后端 strategy_daily_stat 一致（毛利 = 营收 − 销售成本，报废不动成本） */
function addStat(strategy, { soldQty = 0, scrapQty = 0, revenue = 0, cost = 0 }) {
  if (!strategy) return
  const d = state.statDelta.get(strategy) || { soldQty: 0, scrapQty: 0, revenue: 0, cost: 0 }
  d.soldQty += soldQty
  d.scrapQty += scrapQty
  d.revenue += revenue
  d.cost += cost
  state.statDelta.set(strategy, d)
}
state.nextId.decision = maxOf(state.onSale.map((r) => r.decisionId))
state.nextId.task = maxOf(Object.values(fixtures.gets).flatMap((b) => b.data?.byTask || []).map((t) => t.taskId))
state.nextId.log = maxOf([...state.taskLogs.values()].flat().map((l) => l.logId))
state.nextId.sale = Number(fixtures.posts.feedback?.data?.salesRecordId) || 100000
state.nextId.batch = maxOf([
  ...state.nearExpiry.map((r) => r.batchId),
  ...[...state.inStock.values()].flat().map((r) => r.batchId)
])
const next = (name) => ++state.nextId[name]

/** 批次现存变了：临期清单、风险清单、在售批次、特价余量一起改 */
function setBatchRemain(batchId, remain, status) {
  let delta = null
  let itemId = null
  const touch = (row) => {
    if (row.batchId !== batchId) return
    if (delta === null) delta = remain - Number(row.remainQty)
    itemId = row.itemId
    row.remainQty = round2(remain)
    if ('status' in row) row.status = status
  }
  state.nearExpiry.forEach(touch)
  state.atRisk.forEach(touch)
  for (const rows of state.inStock.values()) rows.forEach(touch)
  if (status !== 'ON_SALE') {
    state.nearExpiry = state.nearExpiry.filter((r) => r.batchId !== batchId)
    state.atRisk = state.atRisk.filter((r) => r.batchId !== batchId)
  }
  const sale = state.onSale.find((r) => r.itemId === itemId)
  if (sale && delta) sale.remainQty = round2(Math.max(0, Number(sale.remainQty) + delta))
}

function findBatch(batchId) {
  const pools = [state.nearExpiry, ...state.inStock.values()]
  for (const rows of pools) {
    const row = rows.find((r) => r.batchId === batchId)
    if (row) return row
  }
  return null
}

/** 单品当天最近一次出建议的策略（报废、销售按它计入策略统计，与后端口径一致） */
function strategyOfItem(itemId) {
  for (const s of [...state.generated].reverse()) {
    if (state.suggestions[s].some((r) => r.itemId === itemId)) return s
  }
  return null
}

// ------------------------------------------------------------------ 查询
function getSuggestions({ bizDate, strategy }) {
  if (bizDate !== BIZ) return notInDemo()
  const rows = strategy ? state.suggestions[strategy] || [] : [...allSuggestions()].sort((a, b) => a.id - b.id)
  return ok(clone(rows))
}

function taskRows() {
  return state.newTasks.map((t) => {
    const row = clone(t)
    delete row.preview
    return row
  })
}

/** 推送效果：录下的统计 + 演示中新建/新发的计划 + 演示中新标记的打开 */
function getPushStats(params) {
  const body = recorded('/push/stats', params)
  if (!body) return notInDemo()
  if (body.code !== 0) return clone(body)
  const stats = clone(body.data)
  if (BIZ < params.from || BIZ > params.to) return ok(stats)
  for (const row of stats.byTask || []) {
    const extra = state.openedInDemo.get(row.taskId) || 0
    row.opened += extra
    row.openRate = row.delivered ? round2(row.opened / row.delivered) : row.openRate
    stats.opened += extra
  }
  for (const row of taskRows()) {
    stats.byTask.push(row)
    stats.taskCount += 1
    if (row.status === 'SENT') {
      stats.sentTasks += 1
      stats.delivered += row.delivered
      stats.opened += row.opened
      stats.converted += row.converted
      stats.groupRows += row.groupRows
      stats.skippedLimit += row.skippedLimit
      stats.skippedQuiet += row.skippedQuiet
      stats.skippedOptOut += row.skippedOptOut
    } else {
      stats.plannedTasks += 1
    }
  }
  stats.openRate = stats.delivered ? round2(stats.opened / stats.delivered) : stats.openRate
  stats.convertRate = stats.delivered ? round2(stats.converted / stats.delivered) : stats.convertRate
  return ok(stats)
}

function getPushTasks(params) {
  const taskId = Number(params.taskId)
  const created = state.newTasks.find((t) => t.taskId === taskId)
  if (created) return ok([{ ...taskRows().find((t) => t.taskId === taskId), logs: clone(state.taskLogs.get(taskId) || []) }])
  const body = recorded('/push/tasks', params)
  if (!body) return notInDemo()
  const rows = clone(body.data)
  for (const row of rows) row.logs = clone(state.taskLogs.get(row.taskId) || row.logs)
  return ok(rows)
}

/** 效果看板：录下的统计 + 演示中登记的销售、报废（只加到营业日 BIZ 那天，区间不含 BIZ 时原样返回） */
function getEffect(params) {
  const body = recorded('/sales/effect', params)
  if (!body) return notInDemo()
  if (body.code !== 0 || !state.statDelta.size || BIZ < params.from || BIZ > params.to) return clone(body)
  const data = clone(body.data)
  const apply = (row, d) => {
    row.soldQty = round2(Number(row.soldQty) + d.soldQty)
    row.scrapQty = round2(Number(row.scrapQty) + d.scrapQty)
    row.revenue = round2(Number(row.revenue) + d.revenue)
    row.cost = round2(Number(row.cost) + d.cost)
    row.grossProfit = round2(row.revenue - row.cost)
    const base = row.soldQty + row.scrapQty
    row.scrapRate = base > 0 ? Math.round((row.scrapQty / base) * 10000) / 10000 : 0
  }
  const blank = (extra) => ({ soldQty: 0, scrapQty: 0, revenue: 0, cost: 0, grossProfit: 0, scrapRate: 0, stockoutRate: 0, ...extra })
  for (const [strategy, d] of state.statDelta) {
    if (data.strategy && data.strategy !== 'ALL' && data.strategy !== strategy) continue
    data.daily = data.daily || []
    let day = data.daily.find((r) => r.bizDate === BIZ && r.strategy === strategy)
    if (!day) data.daily.push((day = blank({ bizDate: BIZ, strategy })))
    apply(day, d)
    data.byStrategy = data.byStrategy || []
    let row = data.byStrategy.find((r) => r.strategy === strategy)
    if (!row) data.byStrategy.push((row = blank({ strategy, days: 1 })))
    apply(row, d)
    apply(data, d)
  }
  return ok(data)
}

function getNearExpiry({ bizDate, days }) {
  if (bizDate !== BIZ) return notInDemo()
  const limit = days === undefined ? 2 : Number(days)
  return ok(clone(state.nearExpiry.filter((r) => r.daysLeft <= limit)))
}

function getInStock(params) {
  const rows = state.inStock.get(requestKey('/batches/in-stock', params))
  return rows ? ok(clone(rows)) : notInDemo()
}

// ------------------------------------------------------------------ 提交
function generate({ bizDate, strategy }) {
  if (bizDate !== BIZ) return notInDemo()
  const s = strategy || 'RULE'
  if (state.generated.includes(s)) return clone(fixtures.posts[`generate:${s}:again`])
  const result = clone(fixtures.posts[`generate:${s}:first`])
  const rows = clone(fixtures.generated[s]?.data || [])
  // 演示中改过价的单品可能已经到了每日调价上限：与后端一样不出建议，并在说明里列出来
  const blocked = rows.filter((r) => adjustCount(r.itemId) >= MAX_ADJUST_PER_DAY)
  state.generated.push(s)
  state.suggestions[s] = rows.filter((r) => !blocked.includes(r))
  if (blocked.length && result?.data) {
    const data = result.data
    const recordedReasons = data.adjustLimitNote ? [data.adjustLimitNote.replace(/^.*?被拒绝：/, '')] : []
    const skipped = (data.skippedByAdjustLimit || 0) + blocked.length
    data.generated = state.suggestions[s].length
    data.skippedByAdjustLimit = skipped
    data.adjustLimitNote = `有 ${skipped} 个单品因「同一单品每天最多调价 ${MAX_ADJUST_PER_DAY} 次」被拒绝：` +
      [...recordedReasons, ...blocked.map((r) => adjustLimitReason(r.itemName))].map((t) => t.replace(/。$/, '')).join('；') + '。'
    if (data.effectiveStrategies && s in data.effectiveStrategies) data.effectiveStrategies[s] = data.generated
  }
  return result
}

function decide({ suggestionId, finalPrice, accepted, reason }) {
  const row = allSuggestions().find((r) => r.id === Number(suggestionId))
  if (!row) return fail(404, `定价建议不存在：suggestionId=${suggestionId}`)
  const price = round2(finalPrice)
  const original = Number(row.originalPrice)
  const lowest = round2(original * MIN_DISCOUNT_RATE)
  if (price < lowest - 0.005) {
    return fail(400, `改价被拒绝：¥${money(price)}（原价 ¥${money(original)}，相当于 ${discountLabel(price / original)}）` +
      `低于店主设定的最低折扣线 ${discountLabel(MIN_DISCOUNT_RATE)}（app.pricing.min-discount-rate）；本单最低可售 ¥${money(lowest)}。` +
      '要清库存请改批次到货量或等明天再调。')
  }
  const changed = Math.abs(price - Number(row.suggestedPrice)) >= 0.005
  // 店主改价同样计入"同一单品每天最多调价 2 次"（后端先查最低折扣线，再查调价次数）
  if (changed && adjustCount(row.itemId) >= MAX_ADJUST_PER_DAY) return fail(400, adjustLimitReason(row.itemName))
  if (changed) state.priceChanges.set(row.itemId, (state.priceChanges.get(row.itemId) || 0) + 1)
  const decisionId = next('decision')
  const decidedAt = now()
  Object.assign(row, { decided: true, finalPrice: price })

  // 顾客端特价：一个单品一天一个价签，取店主最新的决策
  const rate = round2(price / original)
  const item = itemById.get(row.itemId) || {}
  const sale = state.onSale.find((r) => r.itemId === row.itemId)
  const fields = { finalPrice: price, discountRate: rate, discountLabel: discountLabel(rate), decisionAt: decidedAt, suggestionId: row.id, decisionId }
  if (sale) {
    Object.assign(sale, fields)
  } else {
    state.onSale.push({
      batchId: row.batchId, batchNo: row.batchNo, itemId: row.itemId, itemName: row.itemName,
      categoryName: item.categoryName, unit: item.unit, originalPrice: original,
      daysLeft: row.daysLeft, expireDate: shiftDate(BIZ, row.daysLeft), freshness: row.freshness,
      atRisk: state.atRisk.some((r) => r.itemId === row.itemId), remainQty: row.remainQty, ...fields
    })
  }
  return ok({
    ...clone(fixtures.posts.decide.data),
    decisionId, accepted: accepted !== false && !changed, finalPrice: price, suggestedPrice: Number(row.suggestedPrice),
    reason: reason || (changed ? '店主改价' : '采纳系统建议'), decidedAt, changed
  })
}

const PREVIEW_RATES = Object.keys(fixtures.posts.preview[String(items[0].id)]?.byRate || {})

/** 把录下的预览文案换成店主确认价：标题、正文里的折扣和现价，以及价格来源说明 */
function useConfirmedPrice(preview, confirmed) {
  const price = round2(confirmed.finalPrice)
  const rate = round2(confirmed.discountRate ?? price / Number(preview.basePrice))
  const label = discountLabel(rate)
  const oldLabel = preview.discountLabel
  const oldPrice = money(preview.discountPrice)
  if (oldLabel && oldLabel !== label) {
    preview.title = String(preview.title).split(oldLabel).join(label)
    preview.content = String(preview.content).split(oldLabel).join(label)
  }
  preview.content = String(preview.content).split(`现价 ¥${oldPrice}`).join(`现价 ¥${money(price)}`)
  Object.assign(preview, {
    discountRate: rate, discountPrice: price, discountLabel: label, priceSource: 'CONFIRMED', priceDecisionId: confirmed.decisionId,
    priceNote: `价格取店主确认价 ¥${money(price)}（定价决策 #${confirmed.decisionId}，单品统一价）`
  })
}

/** 某会员在营业日当天已收到的个人推送条数（录下的计划 + 演示中发的） */
function deliveredToday(memberId) {
  let n = 0
  for (const logs of state.taskLogs.values()) {
    n += logs.filter((l) => l.memberId === memberId && l.delivered && String(l.sentAt).startsWith(BIZ)).length
  }
  return n
}

/** 计划发送时间是否落在静默时段（如 22:00-08:00，可跨零点） */
function inQuietHours(planTime) {
  const [start, end] = QUIET_HOURS.split('-').map((t) => Number(t.split(':')[0]))
  const hour = Number(String(planTime || '').slice(11, 13))
  if (!Number.isFinite(hour) || !Number.isFinite(start) || !Number.isFinite(end)) return false
  return start > end ? hour >= start || hour < end : hour >= start && hour < end
}

function previewPush({ itemId, bizDate, discountRate }) {
  if (bizDate !== BIZ) return notInDemo()
  const entry = fixtures.posts.preview[String(itemId)]
  if (!entry) return fail(404, `单品不存在：itemId=${itemId}`)
  // 与后端一样：店主当天确认过价格的单品，一律用确认价（包括演示中刚确认的），不按页面上选的折扣试算
  const confirmed = state.onSale.find((r) => r.itemId === Number(itemId) && r.decisionId)
  const wanted = confirmed ? Number(confirmed.discountRate) : Number(discountRate)
  // 录了 0.5~1.0 每 0.1 一档；别的折扣取最近的一档（用确认价时只挑能正常出预览的档，再把价格换成确认价）
  const usable = confirmed ? PREVIEW_RATES.filter((r) => !entry.byRate[r].error && (wanted >= 0.995 || Number(r) < 0.995)) : PREVIEW_RATES
  const rate = usable.reduce((best, r) => (Math.abs(r - wanted) < Math.abs(best - wanted) ? r : best), usable[0])
  const variant = entry.byRate[rate]
  if (variant.error) return clone(variant.error)
  const preview = { ...clone(entry.base), ...clone(variant), taskId: next('task'), planStatus: 'PLANNED' }
  if (confirmed) useConfirmedPrice(preview, confirmed)
  state.newTasks.push({
    taskId: preview.taskId, bizDate: BIZ, planTime: preview.planTime, sentAt: null, status: 'PLANNED', channel: 'IN_APP',
    relatedItemId: preview.itemId, itemName: preview.itemName, relatedSuggestionId: preview.relatedSuggestionId,
    targetCount: preview.targetCount, title: preview.title, reason: preview.reason, audienceRule: preview.audienceRule,
    delivered: 0, opened: 0, converted: 0, skippedLimit: 0, skippedQuiet: 0, skippedOptOut: 0, groupRows: 0,
    openRate: null, convertRate: null, preview
  })
  return ok(preview)
}

function sendPush({ taskId }) {
  const template = fixtures.posts.send.data
  const id = Number(taskId)
  const task = state.newTasks.find((t) => t.taskId === id)
  if (!task) {
    if (!state.taskLogs.has(id)) return fail(404, `推送计划不存在：taskId=${taskId}`)
    // 录下的计划在快照里已经发过了：与后端一样命中幂等，不重复发送
    return ok({ ...clone(template), sent: 0, sentPersonal: 0, sentGroup: 0, messageIds: [], sentItems: [], taskId: id, taskIds: [id], alreadySent: true })
  }
  if (task.status === 'SENT') {
    return ok({ ...clone(template), sent: 0, sentPersonal: 0, sentGroup: 0, messageIds: [], sentItems: [], taskId: id, taskIds: [id], alreadySent: true, taskStatus: 'SENT' })
  }
  const sendAt = now()
  const { preview } = task
  // 与后端一样逐人检查：计划时间落在静默时段的整批不发；当天已收满上限的会员跳过并记原因（退订会员在选人时已排除）
  const quiet = inQuietHours(task.planTime)
  const targets = []
  const skipped = []
  for (const t of preview.targets || []) {
    const received = deliveredToday(t.memberId)
    if (quiet) {
      skipped.push({ memberId: t.memberId, nickname: t.nickname, skipReason: '静默', reason: `计划时间在静默时段 ${QUIET_HOURS}，不打扰` })
    } else if (received >= DAILY_PUSH_LIMIT) {
      skipped.push({ memberId: t.memberId, nickname: t.nickname, skipReason: '限频',
        reason: `今天已收到 ${received} 条，达到每人每天 ${DAILY_PUSH_LIMIT} 条的上限` })
    } else {
      targets.push(t)
    }
  }
  const sentItems = targets.map((t) => ({
    logId: next('log'), taskId: id, memberId: t.memberId, nickname: t.nickname, channel: 'IN_APP',
    title: preview.title, content: preview.content, sendAt
  }))
  const groupLogId = next('log')
  const logRow = (logId, memberId, label, delivered, skipReason = null) => ({
    logId, taskId: id, memberId, memberNo: memberId ? 'M' + String(memberId).padStart(4, '0') : null, memberLabel: label,
    sentAt: sendAt, delivered, opened: false, openedAt: null, converted: false, convertedAt: null, relatedSaleId: null,
    convertWindowHours: template.convertWindowHours, skipReason
  })
  state.taskLogs.set(id, [
    ...sentItems.map((s) => logRow(s.logId, s.memberId, s.nickname, true)),
    ...skipped.map((s) => logRow(next('log'), s.memberId, s.nickname, false, s.skipReason)),
    logRow(groupLogId, null, '全店群发文案', false)
  ])
  const skippedLimit = skipped.filter((s) => s.skipReason === '限频').length
  const skippedQuiet = skipped.filter((s) => s.skipReason === '静默').length
  Object.assign(task, {
    status: 'SENT', sentAt: sendAt, delivered: sentItems.length, groupRows: 1, skippedLimit, skippedQuiet,
    openRate: sentItems.length ? 0 : null, convertRate: sentItems.length ? 0 : null
  })
  return ok({
    ...clone(template),
    sent: sentItems.length + 1, sentPersonal: sentItems.length, sentGroup: 1, skippedByLimit: skippedLimit,
    skippedByQuietHours: skippedQuiet, skippedByOther: 0, skippedByUnsubscribed: 0, skipped, groupMessageId: groupLogId,
    messageIds: [...sentItems.map((s) => s.logId), groupLogId], sentItems, sendAt, taskId: id, taskIds: [id],
    taskStatus: 'SENT', planTime: task.planTime, alreadySent: false, quietNow: quiet,
    note: `计划 #${id} 已送达 ${sentItems.length} 条个人推送 + 1 条群发文案` +
      (skipped.length ? `；限频跳过 ${skippedLimit} 人、静默跳过 ${skippedQuiet} 人` : '') + '（演示版：只改了页面上的数据）'
  })
}

function markOpened({ logId }) {
  const id = Number(logId)
  for (const [taskId, logs] of state.taskLogs) {
    const log = logs.find((l) => l.logId === id)
    if (!log) continue
    const alreadyOpened = log.opened === true
    if (!alreadyOpened) {
      Object.assign(log, { opened: true, openedAt: now() })
      const created = state.newTasks.find((t) => t.taskId === taskId)
      if (created) {
        created.opened += 1
        created.openRate = created.delivered ? round2(created.opened / created.delivered) : 0
      } else {
        state.openedInDemo.set(taskId, (state.openedInDemo.get(taskId) || 0) + 1)
      }
    }
    return ok({ ...clone(fixtures.posts.open.data), logId: id, taskId, memberId: log.memberId, opened: true,
      openedAt: log.openedAt, alreadyOpened, converted: log.converted, relatedSaleId: log.relatedSaleId })
  }
  return fail(404, `推送记录不存在：logId=${logId}`)
}

function attribute(payload) {
  return ok({ ...clone(fixtures.posts.attribute.data), from: payload.from, to: payload.to })
}

function feedback(payload) {
  const previous = state.feedbackByRequestNo.get(payload.requestNo)
  if (previous) return ok({ ...clone(previous), duplicate: true })
  const itemId = Number(payload.itemId)
  const quantity = Number(payload.quantity)
  if (!itemById.has(itemId)) return fail(404, `单品不存在：itemId=${payload.itemId}`)
  if (!(quantity > 0)) return fail(400, '数量必须大于 0')
  if (payload.bizDate !== BIZ) return notInDemo()

  const batches = state.inStock.get(requestKey('/batches/in-stock', { itemId, bizDate: BIZ, includeSoldOut: !!payload.isReturn })) || []
  const batch = payload.batchId
    ? findBatch(Number(payload.batchId))
    : batches.find((b) => b.status !== 'SOLD_OUT')
  if (!batch) return fail(400, '该单品当前没有在售库存，无法登记（退货请选择原批次）')

  const remain = Number(batch.remainQty)
  const isReturn = !!payload.isReturn
  const soldQty = isReturn ? quantity : Math.min(quantity, remain)
  const left = isReturn ? remain + quantity : remain - soldQty
  const status = left > 0 ? 'ON_SALE' : 'SOLD_OUT'
  setBatchRemain(batch.batchId, left, status)

  // 推送归因：收到过这个单品推送的会员来买，算推送带来的成交（窗口与口径见后端 docs/05）
  let pushLogId = null
  if (payload.memberId && !isReturn) {
    for (const [taskId, logs] of state.taskLogs) {
      const task = state.newTasks.find((t) => t.taskId === taskId)
      const relatedItemId = task ? task.relatedItemId : fixtures.gets[requestKey('/push/tasks', { taskId })]?.data?.[0]?.relatedItemId
      const log = relatedItemId === itemId && logs.find((l) => l.memberId === Number(payload.memberId) && l.delivered && !l.converted)
      if (log) {
        Object.assign(log, { converted: true, convertedAt: now() })
        if (task) {
          task.converted += 1
          task.convertRate = task.delivered ? round2(task.converted / task.delivered) : 0
        }
        pushLogId = log.logId
        break
      }
    }
  }
  const salesRecordId = next('sale')
  const strategy = strategyOfItem(itemId)
  // 计入效果看板：与后端一样按带符号的数量算（退货为负），成本取批次进价
  if (strategy && (isReturn || soldQty > 0)) {
    const signed = isReturn ? -soldQty : soldQty
    const item = itemById.get(itemId) || {}
    const unitPrice = Number(payload.unitPrice ?? item.basePrice ?? 0)
    const costPrice = Number(batch.costPrice ?? item.costPrice ?? 0)
    addStat(strategy, { soldQty: signed, revenue: round2(unitPrice * signed), cost: round2(costPrice * signed) })
  }
  const result = {
    ...clone(fixtures.posts.feedback.data),
    remainQty: round2(left), batchStatus: status, salesRecordId, bizDate: BIZ, itemId, batchId: batch.batchId,
    batchNo: batch.batchNo, requestedQty: quantity, soldQty, overSell: !isReturn && quantity > remain,
    batchAutoPicked: !payload.batchId, isReturn, strategy, statUpdated: !!strategy,
    message: `已${isReturn ? '退货' : '回流'} ${qty(soldQty)}，批次剩余 ${qty(left)}，状态 ${status}`,
    memberId: payload.memberId ?? null, pushLogId, convertedByPush: pushLogId !== null,
    attributionNote: pushLogId !== null
      ? `归因成功：push_log #${pushLogId} 在 3 小时窗口内命中同单品成交（saleId=${salesRecordId}）`
      : (payload.memberId && !isReturn ? '未归因：该会员 3 小时内没有收到这个单品的推送' : null),
    requestNo: payload.requestNo, duplicate: false
  }
  state.feedbackByRequestNo.set(payload.requestNo, result)
  return ok(result)
}

function scrap(batchId, payload) {
  if (payload.bizDate !== BIZ) return notInDemo()
  const reason = String(payload.reason || '').trim()
  if (!reason) return fail(400, '报废必须写原因（例如：已过期、腐烂、磕碰）')
  const batch = findBatch(Number(batchId))
  if (!batch) return fail(404, `批次不存在：batchId=${batchId}`)
  const remain = Number(batch.remainQty)
  if (remain <= 0) return fail(400, `批次 ${batch.batchNo} 已没有现存，无可报废数量`)
  const amount = payload.qty === undefined || payload.qty === null ? remain : round2(payload.qty)
  if (amount <= 0) return fail(400, '报废数量必须大于 0（按两位小数计）')
  if (amount > remain) return fail(400, `报废数量 ${qty(amount)} 超过批次 ${batch.batchNo} 的现存 ${qty(remain)}`)
  const left = round2(remain - amount)
  const status = left > 0 ? 'ON_SALE' : 'SCRAPPED'
  const operator = String(payload.operator || '').trim() || '店员'
  const strategy = strategyOfItem(batch.itemId)
  setBatchRemain(batch.batchId, left, status)
  addStat(strategy, { scrapQty: amount }) // 报废只加报废量、重算损耗率，不动成本（与后端口径一致）
  return ok({
    batchId: batch.batchId, batchNo: batch.batchNo, scrapQty: amount, totalScrapQty: amount, remainQty: left, status,
    strategy, statUpdated: !!strategy,
    message: `已登记报废 ${qty(amount)}（${reason}，登记人 ${operator}）；` +
      (status === 'SCRAPPED' ? '整批报废，批次已移出临期清单' : `部分报废，批次仍在售，现存 ${qty(left)}`) +
      (strategy ? `；计入策略 ${strategy} 的当日损耗` : '；该单品当天没有定价建议，不计入策略损耗')
  })
}

function createBatch(payload) {
  const item = itemById.get(Number(payload.itemId))
  if (!item) return fail(404, `单品不存在：itemId=${payload.itemId}（可登记的单品 id 是 1～${items.length}）`)
  const arriveDate = payload.arriveDate || BIZ
  const shelfLifeDays = Number(payload.shelfLifeDays) || item.shelfLifeDays
  const batchId = next('batch')
  const seq = String(state.nextId.batch % 100).padStart(2, '0')
  const batchNo = `B${arriveDate.replace(/-/g, '')}-${String(item.id).padStart(4, '0')}-${seq}`
  const expireDate = shiftDate(arriveDate, shelfLifeDays)
  const remainQty = Number(payload.qty)
  const daysLeft = Math.round((new Date(expireDate) - new Date(BIZ)) / 86400000)
  const row = {
    batchId, batchNo, itemId: item.id, itemName: item.itemName, unit: item.unit, arriveDate, expireDate, daysLeft,
    remainQty, basePrice: item.basePrice, status: 'ON_SALE'
  }
  for (const includeSoldOut of [false, true]) {
    const rows = state.inStock.get(requestKey('/batches/in-stock', { itemId: item.id, bizDate: BIZ, includeSoldOut }))
    if (rows) {
      rows.push({ ...row })
      rows.sort((a, b) => a.expireDate.localeCompare(b.expireDate))
    }
  }
  state.nearExpiry.push({
    ...row, categoryName: item.categoryName, costPrice: Number(payload.costPrice), lossRatePct: item.lossRatePct,
    freshness: round2(daysLeft / item.shelfLifeDays), estimatedSellableDays: null, plannedSaleQty: null,
    expectedScrapQty: null, atRisk: false, metricsUpdatedAt: now(), metricsReason: '新登记的批次：指标在下一次临期扫描时计算'
  })
  state.nearExpiry.sort((a, b) => a.daysLeft - b.daysLeft)
  return ok({
    ...clone(fixtures.posts.createBatch.data), batchId, batchNo, expireDate, itemId: item.id, itemName: item.itemName,
    arriveDate, shelfLifeDays, initQty: remainQty, remainQty, costPrice: Number(payload.costPrice), status: 'ON_SALE'
  })
}

// ------------------------------------------------------------------ 路由
const routes = [
  ['get', /^\/pricing\/suggestions$/, (p) => getSuggestions(p)],
  ['get', /^\/push\/stats$/, (p) => getPushStats(p)],
  ['get', /^\/push\/tasks$/, (p) => getPushTasks(p)],
  ['get', /^\/batches\/near-expiry$/, (p) => getNearExpiry(p)],
  ['get', /^\/batches\/at-risk$/, (p) => (p.bizDate === BIZ ? ok(clone(state.atRisk)) : notInDemo())],
  ['get', /^\/batches\/on-sale$/, (p) => (p.bizDate === BIZ ? ok(clone(state.onSale)) : notInDemo())],
  ['get', /^\/batches\/in-stock$/, (p) => getInStock(p)],
  ['get', /^\/sales\/effect$/, (p) => getEffect(p)],
  ['post', /^\/pricing\/suggestions\/generate$/, (p, body) => generate(body)],
  ['post', /^\/pricing\/decisions$/, (p, body) => decide(body)],
  ['post', /^\/push\/preview$/, (p, body) => previewPush(body)],
  ['post', /^\/push\/send$/, (p, body) => sendPush(body)],
  ['post', /^\/push\/open$/, (p, body) => markOpened(body)],
  ['post', /^\/push\/attribute$/, (p, body) => attribute(body)],
  ['post', /^\/sales\/feedback$/, (p, body) => feedback(body)],
  ['post', /^\/batches\/(\d+)\/scrap$/, (p, body, m) => scrap(m[1], body)],
  ['post', /^\/batches$/, (p, body) => createBatch(body)]
]

function handle(method, path, params, body) {
  for (const [m, pattern, fn] of routes) {
    const match = method === m && path.match(pattern)
    if (match) return fn(params, body, match)
  }
  if (method === 'get') {
    const hit = recorded(path, params)
    return hit ? clone(hit) : notInDemo()
  }
  return fail(400, '演示版不支持这个操作')
}

/** axios adapter：与真实后端一样返回 HTTP 200 + 统一响应体，错误也走 code≠0，交给拦截器统一提示 */
export default async function demoAdapter(config) {
  const method = (config.method || 'get').toLowerCase()
  const path = (config.url || '').replace(/^\/api/, '').split('?')[0]
  let body = config.data
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      body = {}
    }
  }
  await new Promise((resolve) => setTimeout(resolve, LATENCY_MS))
  let data
  try {
    data = handle(method, path, { ...(config.params || {}) }, body || {})
  } catch (e) {
    // 演示层自己的问题：如实提示，别让拦截器把它当成"后端没启动"的网络错误
    console.error('[demo]', method.toUpperCase(), path, e)
    data = fail(500, `演示版内部错误：${e?.message || e}`)
  }
  return { data, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, config, request: null }
}
