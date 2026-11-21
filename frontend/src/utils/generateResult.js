import { ElMessage } from 'element-plus'

const STRATEGY_NAME = { FIXED: '固定价格', RULE: '规则折扣', MODEL: '模型定价' }

/**
 * 生成建议的结果提示：有回退、被每日调价上限拦住、没重新生成等情况时如实用警告提示，
 * 只有真的新生成了、且没有任何说明时才提示成功。两个页面（临期清单、定价建议）共用同一口径。
 *
 * 后端对"当天已生成过"和"算下来全部维持原价、一条都不用出"返回的是同一个结果（generated = 0），
 * 所以调用方要把生成后当天这个策略的建议条数（existingCount）传进来：
 * 0 条说明不是"生成过了"，而是这个策略认为当天没有需要降价的单品；不传则沿用原来的提示。
 */
export function notifyGenerateResult(res, strategy, existingCount) {
  const notes = [res?.strategyNote, res?.adjustLimitNote].filter(Boolean)
  const generated = res?.generated ?? 0
  const name = STRATEGY_NAME[strategy] || strategy || ''
  if (notes.length) {
    ElMessage.warning({ message: `新生成 ${generated} 条。` + notes.join('；'), duration: 8000 })
  } else if (generated > 0) {
    ElMessage.success(`已生成 ${generated} 条${name ? '「' + name + '」' : ''}建议`)
  } else if (existingCount === 0) {
    ElMessage.info({
      message: `按${name ? '「' + name + '」' : '所选策略'}算，这一天的在售单品都维持原价，没有需要降价的单品，所以没有生成建议`,
      duration: 6000
    })
  } else {
    ElMessage.info('没有需要新生成的建议（当天已生成过）')
  }
}
