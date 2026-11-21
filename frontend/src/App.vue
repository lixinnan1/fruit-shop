<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
// Element Plus 按需引入后不再 app.use(ElementPlus, { locale })，中文语言包改由模板最外层的
// <el-config-provider> 提供（日期选择器、分页、空状态等内置文案保持中文）
import zhCn from 'element-plus/es/locale/lang/zh-cn'

const route = useRoute()
const activeMenu = computed(() => route.path)
// 顾客端 H5 是独立版式：不带后台侧边栏与顶栏，直接铺满手机屏（演示时按 F12 切手机视口）
const standalone = computed(() => route.meta?.standalone === true)
// 静态演示版（npm run build:demo）：数据是录好的示例，操作只改当前页面，刷新即还原
const isDemo = import.meta.env.VITE_DEMO === 'true'

const MENU = [
  { path: '/', label: '效果看板' },
  { path: '/near-expiry', label: '临期清单' },
  { path: '/pricing', label: '定价建议' },
  { path: '/traffic', label: '客流时段' },
  { path: '/push', label: '推送消息' },
  { path: '/sales', label: '销售回流' },
  { path: '/h5', label: '顾客端 H5 特价页 ↗' }
]

// 手机等窄屏（与样式里的断点一致）：侧栏收进抽屉，页头点"☰"打开，选了页面就收起
const narrowQuery = window.matchMedia('(max-width: 768px)')
const narrow = ref(narrowQuery.matches)
const onNarrowChange = (e) => { narrow.value = e.matches }
narrowQuery.addEventListener('change', onNarrowChange)
onBeforeUnmount(() => narrowQuery.removeEventListener('change', onNarrowChange))
const drawerOpen = ref(false)
watch(() => route.path, () => { drawerOpen.value = false })
</script>

<template>
  <el-config-provider :locale="zhCn">
    <!-- 顾客端 H5：独立布局 -->
    <router-view v-if="standalone" />

    <!-- 店长工作台 -->
    <el-container v-else class="layout">
      <el-header class="header">
        <div class="brand">
          <button v-if="narrow" class="menu-btn" type="button" aria-label="打开菜单" @click="drawerOpen = true">☰</button>
          <span class="logo">🍊</span>
          <div class="brand-text">
            <div class="title">临期果品定价与推送工作台</div>
            <div class="subtitle">建议由系统给出，定价权在店主手里</div>
          </div>
        </div>
        <div class="header-tags">
          <el-tooltip v-if="isDemo" placement="bottom"
                      content="没有连接后端：数据是营业日 2026-06-29 的录制快照，确认、推送、登记等操作只改当前页面，刷新即还原">
            <el-tag type="warning" effect="dark">{{ narrow ? '演示版' : '演示版 · 示例数据' }}</el-tag>
          </el-tooltip>
          <el-tag v-if="!narrow" type="success" effect="plain">决策辅助模式 · 不自动改价</el-tag>
        </div>
      </el-header>

      <el-container>
        <el-aside v-if="!narrow" width="210px" class="aside">
          <el-menu :default-active="activeMenu" router>
            <el-menu-item v-for="m in MENU" :key="m.path" :index="m.path">
              <span>{{ m.label }}</span>
            </el-menu-item>
          </el-menu>
        </el-aside>

        <el-main class="main">
          <router-view />
        </el-main>
      </el-container>

      <el-drawer v-if="narrow" v-model="drawerOpen" direction="ltr" size="230px" :with-header="false">
        <div class="drawer-head">
          <div class="title">临期果品工作台</div>
          <el-tag type="success" effect="plain" size="small">决策辅助模式 · 不自动改价</el-tag>
        </div>
        <el-menu :default-active="activeMenu" router class="drawer-menu">
          <el-menu-item v-for="m in MENU" :key="m.path" :index="m.path">
            <span>{{ m.label }}</span>
          </el-menu-item>
        </el-menu>
      </el-drawer>
    </el-container>
  </el-config-provider>
</template>

<style>
html, body, #app { height: 100%; margin: 0; }
body { background: #f5f7fa; font-family: "Microsoft YaHei", system-ui, sans-serif; }
.layout { height: 100%; }
.header {
  display: flex; align-items: center; justify-content: space-between;
  background: #fff; border-bottom: 1px solid #e4e7ed; height: 64px;
}
.brand { display: flex; align-items: center; gap: 12px; }
.header-tags { display: flex; align-items: center; gap: 8px; }
.logo { font-size: 28px; }
.title { font-size: 17px; font-weight: 600; color: #303133; }
.subtitle { font-size: 12px; color: #909399; }
.aside { background: #fff; border-right: 1px solid #e4e7ed; }
.main { padding: 18px; }
.page-title { font-size: 16px; font-weight: 600; margin: 0 0 4px; }
.page-desc { font-size: 13px; color: #909399; margin: 0 0 16px; }
.menu-btn {
  border: none; background: none; font-size: 22px; line-height: 1; padding: 4px 6px; margin-left: -6px;
  color: #303133; cursor: pointer;
}
.drawer-head { padding: 4px 4px 12px; display: flex; flex-direction: column; gap: 8px; }
.drawer-menu { border-right: none; }

/* 手机等窄屏：断点与 App.vue 里的 narrowQuery 一致 */
@media (max-width: 768px) {
  .header { padding: 0 12px; height: 56px; gap: 8px; }
  .brand { gap: 8px; min-width: 0; }
  .brand-text { min-width: 0; }
  .logo { font-size: 22px; }
  .title { font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .subtitle { display: none; }
  .header-tags { flex-shrink: 0; }
  .main { padding: 12px; }
  .page-desc { margin-bottom: 12px; }

  /* 页面里写死宽度的输入框、选择框、日期框：窄屏上最多占满一行 */
  .main .el-select, .main .el-date-editor, .main .el-input, .main .el-input-number { max-width: 100%; }

  /* 非行内表单：标签放到输入框上方，不再挤占一半宽度 */
  .main .el-form:not(.el-form--inline) .el-form-item,
  .el-dialog .el-form:not(.el-form--inline) .el-form-item { flex-direction: column; align-items: stretch; }
  .main .el-form:not(.el-form--inline) .el-form-item__label,
  .el-dialog .el-form:not(.el-form--inline) .el-form-item__label {
    width: auto !important; justify-content: flex-start; height: auto; line-height: 22px; margin-bottom: 4px;
  }

  /* 对话框占满屏宽（各页面写的是 460px 之类的固定宽度） */
  .el-dialog { --el-dialog-width: 92vw; width: 92vw !important; margin-top: 8vh !important; }
}
</style>
