/* MergeGraph Phase 2 UI. The global Vue build is vendored in /vendor so the
 * local project manager remains usable without an internet connection. */
const { createApp, ref, reactive, computed, onMounted, nextTick } = window.Vue;

const api = async (url, options = {}) => {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败 ${response.status}`);
  return body;
};
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const fmtBytes = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const fmtDate = (value) => value ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

const app = {
  setup() {
    const activeSection = ref('project');
    const railOpen = ref(false);
    const railPinned = ref(false);
    const loading = ref(true);
    const notice = ref('');
    const error = ref('');
    const projects = ref([]);
    const currentProject = ref(null);
    const files = ref([]);
    const scan = ref(null);
    const assets = ref([]);
    const runs = ref([]);
    const canvas = reactive({ nodes: [], edges: [], selected: null });
    const analysis = ref(null);
    const analysisMode = ref('architecture');
    const analysisPrompt = ref('生成仓库高层架构图，限制 8-12 个核心节点，并为每个结论提供文件路径和行号证据。');
    const projectForm = reactive({ name: '', rootPath: '' });
    const provider = reactive({ baseUrl: '', model: 'mergegraph-local-mock', apiKey: '', hasApiKey: false, timeoutMs: 30000 });
    const runForm = reactive({ prompt: '整理当前项目的研究上下文' });
    const search = ref('');
    let railCloseTimer = null;
    const filteredAssets = computed(() => assets.value.filter((asset) => !search.value || [asset.filename, asset.notes, asset.prompt, ...(asset.tags || [])].join(' ').toLowerCase().includes(search.value.toLowerCase())));
    const includedFiles = computed(() => files.value.filter((file) => file.included));
    const excludedFiles = computed(() => files.value.filter((file) => !file.included));
    const graphNodes = computed(() => analysis.value?.document?.diagram?.nodes?.length ? analysis.value.document.diagram.nodes : canvas.nodes.map((node) => ({ id: node.id, label: node.data?.title || node.id, summary: node.data?.body || '', kind: node.type })));
    const graphEdges = computed(() => analysis.value?.document?.diagram?.edges || canvas.edges);
    const sectionTitle = computed(() => ({ project: '项目工作区', scan: '扫描与快照', architecture: '架构分析', assets: '文件与资产', canvas: '无限画布', workflow: '运行中心', settings: '项目设置' }[activeSection.value] || '项目工作区'));

    const showError = (cause) => { error.value = cause?.message || String(cause); notice.value = ''; };
    const showNotice = (message) => { notice.value = message; error.value = ''; window.setTimeout(() => { if (notice.value === message) notice.value = ''; }, 3600); };
    const openRail = () => { if (railCloseTimer) window.clearTimeout(railCloseTimer); railOpen.value = true; };
    const closeRail = () => { if (railPinned.value) return; if (railCloseTimer) window.clearTimeout(railCloseTimer); railCloseTimer = window.setTimeout(() => { if (!railPinned.value) railOpen.value = false; }, 420); };
    const togglePin = () => { railPinned.value = !railPinned.value; railOpen.value = railPinned.value || railOpen.value; };
    const selectSection = (section) => { activeSection.value = section; openRail(); };

    async function loadProvider() {
      const result = await api('/api/settings/provider');
      Object.assign(provider, result.provider || {});
      provider.apiKey = '';
    }
    async function loadCanvas() {
      const result = await api('/api/canvas');
      canvas.nodes = result.nodes || []; canvas.edges = result.edges || [];
    }
    async function loadAssets() { assets.value = (await api('/api/assets?limit=200')).assets || []; }
    async function loadRuns() { runs.value = (await api('/api/runs')).runs || []; }
    async function loadProjects() {
      const result = await api('/api/projects');
      projects.value = result.projects || [];
      if (!currentProject.value && projects.value[0]) await selectProject(projects.value[0]);
    }
    async function selectProject(project) {
      currentProject.value = project;
      projectForm.name = project.name || ''; projectForm.rootPath = project.rootPath || '';
      scan.value = project.latestSnapshot || null;
      if (scan.value?.status === 'succeeded') await loadFiles(scan.value.id);
      await loadLatestAnalysis(project.id);
    }
    async function loadFiles(snapshotId) {
      if (!currentProject.value || !snapshotId) return;
      const result = await api(`/api/projects/${currentProject.value.id}/snapshots/${snapshotId}/files?limit=1000`);
      files.value = result.files || [];
    }
    async function loadLatestAnalysis(projectId) {
      if (!projectId) return;
      const result = await api(`/api/projects/${projectId}/analyses`);
      analysis.value = result.analyses?.[0] || null;
    }
    async function createProject() {
      if (!projectForm.rootPath.trim()) return showError(new Error('请先输入本地项目目录地址'));
      try {
        const result = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: projectForm.name, rootPath: projectForm.rootPath, privacyMode: 'local_only' }) });
        await loadProjects(); await selectProject(result.project); showNotice(result.existing ? '已打开已有项目' : '项目已登记，可以开始扫描');
      } catch (cause) { showError(cause); }
    }
    async function startScan() {
      if (!currentProject.value) return showError(new Error('请先登记一个项目'));
      try {
        const result = await api(`/api/projects/${currentProject.value.id}/scans`, { method: 'POST', body: JSON.stringify({ preview: false }) });
        scan.value = result.snapshot; activeSection.value = 'scan'; notice.value = '正在扫描项目目录…';
        for (let i = 0; i < 120; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 150));
          const state = await api(`/api/scans/${result.scanId}`); scan.value = state.scan;
          if (['succeeded', 'failed'].includes(scan.value.status)) break;
        }
        if (scan.value.status !== 'succeeded') throw new Error(scan.value.error || '扫描失败');
        await loadFiles(scan.value.id); await loadProjects(); showNotice(`扫描完成：纳入 ${scan.value.stats?.included || 0} 个文件`);
      } catch (cause) { showError(cause); }
    }
    async function generateArchitecture() {
      if (!currentProject.value || !scan.value?.id || scan.value.status !== 'succeeded') return showError(new Error('请先完成一次项目扫描'));
      try {
        activeSection.value = 'architecture'; analysis.value = { status: 'running', mode: analysisMode.value };
        const result = await api(`/api/projects/${currentProject.value.id}/analyses`, { method: 'POST', body: JSON.stringify({ snapshotId: scan.value.id, mode: analysisMode.value, prompt: analysisPrompt.value, externalAiOptIn: currentProject.value.privacyMode === 'external_ai_opt_in' }) });
        analysis.value = result.analysis; await loadCanvas();
        if (analysis.value.status === 'succeeded') showNotice(`架构图已生成：${analysis.value.document?.diagram?.nodes?.length || 0} 个节点`);
        else showError(new Error(analysis.value.error || '架构分析失败'));
      } catch (cause) { analysis.value = null; showError(cause); }
    }
    async function saveProvider() {
      try {
        const payload = { baseUrl: provider.baseUrl, model: provider.model, timeoutMs: provider.timeoutMs };
        if (provider.apiKey.trim()) payload.apiKey = provider.apiKey.trim();
        const result = await api('/api/settings/provider', { method: 'PUT', body: JSON.stringify(payload) }); Object.assign(provider, result.provider || {}); provider.apiKey = ''; showNotice('全项目 Provider 已保存');
      } catch (cause) { showError(cause); }
    }
    async function updatePrivacy(event) {
      if (!currentProject.value) return;
      try {
        const privacyMode = event.target.checked ? 'external_ai_opt_in' : 'local_only';
        const result = await api(`/api/projects/${currentProject.value.id}`, { method: 'PATCH', body: JSON.stringify({ privacyMode }) });
        currentProject.value = result.project; showNotice(privacyMode === 'external_ai_opt_in' ? '已允许本项目使用外部 AI' : '已恢复本机只读模式');
      } catch (cause) { event.target.checked = currentProject.value.privacyMode === 'external_ai_opt_in'; showError(cause); }
    }
    async function clearProviderKey() {
      try { const result = await api('/api/settings/provider', { method: 'PUT', body: JSON.stringify({ clearApiKey: true }) }); Object.assign(provider, result.provider || {}); provider.apiKey = ''; showNotice('API Key 已清除'); } catch (cause) { showError(cause); }
    }
    async function saveCanvas() {
      try { await api('/api/canvas', { method: 'PUT', body: JSON.stringify({ nodes: canvas.nodes, edges: canvas.edges }) }); showNotice('画布已保存'); } catch (cause) { showError(cause); }
    }
    function addCanvasNote() {
      canvas.nodes.push({ id: `node_${crypto.randomUUID().replaceAll('-', '')}`, type: 'note', position: { x: 120 + canvas.nodes.length * 24, y: 120 + canvas.nodes.length * 18 }, size: { width: 230, height: 140 }, data: { title: '研究笔记', body: '记录假设、证据或下一步。' } });
    }
    async function importFiles(event) {
      for (const file of [...event.target.files]) {
        const dataBase64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
        try { const result = await api('/api/assets', { method: 'POST', body: JSON.stringify({ filename: file.name, mime: file.type || 'application/octet-stream', dataBase64, context: { tags: [] } }) }); assets.value = [result.asset, ...assets.value.filter((asset) => asset.id !== result.asset.id)]; } catch (cause) { showError(cause); }
      }
      event.target.value = ''; showNotice('资产已导入');
    }
    async function runTask() {
      try { const inputAssetIds = canvas.nodes.map((node) => node.data?.assetId).filter(Boolean); const result = await api('/api/runs', { method: 'POST', body: JSON.stringify({ prompt: runForm.prompt, inputAssetIds }) }); runs.value.unshift(result.run); await loadCanvas(); showNotice('任务已完成并记录'); } catch (cause) { showError(cause); }
    }
    function selectCanvasNode(node) { canvas.selected = node; activeSection.value = 'canvas'; }
    function openArtifact() { const path = analysis.value?.document?.artifactPath; if (path) window.open(`/api/architecture-documents/${analysis.value.document.id}/preview`, '_blank', 'noopener'); }
    function onKeydown(event) { if (event.key === '[') { railPinned.value = !railPinned.value; railOpen.value = railPinned.value; } if (event.key === 'Escape') { railPinned.value = false; railOpen.value = false; } if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') generateArchitecture(); }
    onMounted(async () => { window.addEventListener('keydown', onKeydown); try { await Promise.all([loadProvider(), loadAssets(), loadRuns(), loadCanvas(), loadProjects()]); } catch (cause) { showError(cause); } finally { loading.value = false; } });

    return { activeSection, railOpen, railPinned, loading, notice, error, projects, currentProject, files, scan, assets, runs, canvas, analysis, analysisMode, analysisPrompt, projectForm, provider, runForm, search, filteredAssets, includedFiles, excludedFiles, graphNodes, graphEdges, sectionTitle, openRail, closeRail, togglePin, selectSection, selectProject, createProject, startScan, generateArchitecture, saveProvider, updatePrivacy, clearProviderKey, saveCanvas, addCanvasNote, importFiles, runTask, selectCanvasNode, openArtifact, fmtBytes, fmtDate, esc };
  },
  template: `
  <div class="app-shell phase2-shell" :class="{ 'rail-expanded': railOpen || railPinned }">
    <header class="topbar phase2-topbar">
      <div class="brand"><span class="brand-mark">M</span><div><strong>MergeGraph</strong><small>Local Project Intelligence</small></div></div>
      <div class="project-status" v-if="currentProject"><span class="status-dot"></span><b>{{ currentProject.name }}</b><span class="muted">{{ scan?.status === 'succeeded' ? '已扫描' : '待扫描' }}</span></div>
      <div class="top-actions"><button class="ghost" @click="selectSection('settings')">全局设置</button><button class="primary" @click="generateArchitecture">一键生成架构图 <span>⌘↵</span></button></div>
    </header>
    <main class="workspace phase2-workspace">
      <aside class="side-rail" @mouseenter="openRail" @mouseleave="closeRail" @focusin="openRail" @focusout="closeRail">
        <button class="rail-pin" :aria-label="railPinned ? '取消固定侧栏' : '固定侧栏'" @click="togglePin">{{ railPinned ? '◆' : '◇' }}</button>
        <nav><button v-for="item in [{id:'project',icon:'⌂',label:'项目'},{id:'scan',icon:'⌁',label:'扫描'},{id:'architecture',icon:'⌘',label:'架构分析'},{id:'assets',icon:'▦',label:'文件与资产'},{id:'canvas',icon:'◈',label:'画布'},{id:'workflow',icon:'▶',label:'工作流'},{id:'settings',icon:'⚙',label:'设置'}]" :key="item.id" :class="{active:activeSection===item.id}" :title="item.label" @click="selectSection(item.id)"><span class="rail-icon">{{ item.icon }}</span><span class="rail-label">{{ item.label }}</span><em v-if="item.id==='scan' && scan?.status==='running'">●</em></button></nav>
      </aside>
      <section class="main-stage">
        <div class="stage-toolbar"><div><span class="eyebrow">LOCAL PROJECT</span><h1>{{ sectionTitle }}</h1></div><div class="toolbar-actions"><button class="ghost" @click="startScan" :disabled="!currentProject">重新扫描</button><button class="ghost" @click="saveCanvas">保存画布</button></div></div>
        <div v-if="notice" class="toast success">{{ notice }}</div><div v-if="error" class="toast error">{{ error }}</div>
        <div v-if="loading" class="loading-panel">正在加载本地项目工作台…</div>
        <div v-else class="stage-body">
          <section v-if="activeSection==='project'" class="content-grid project-grid"><div class="card hero-card"><span class="eyebrow">PROJECT IMPORTER</span><h2>把本地目录变成可复核的科研上下文</h2><p>输入本机项目目录地址。MergeGraph 只读扫描，源码不会自动复制或发送到外部服务。</p><div class="form-row"><input v-model="projectForm.rootPath" placeholder="例如：<PROJECT_ROOT>\\my-repo" /><input v-model="projectForm.name" placeholder="项目名称（可选）" /><button class="primary" @click="createProject">登记项目</button></div></div><div class="card"><div class="card-title"><b>最近项目</b><span class="muted">{{ projects.length }} 个</span></div><div v-if="!projects.length" class="empty-panel">还没有项目。先输入一个本地目录。</div><button v-for="project in projects" :key="project.id" class="project-row" :class="{selected:currentProject?.id===project.id}" @click="selectProject(project)"><span class="project-dot"></span><span><b>{{ project.name }}</b><small>{{ project.rootPath }}</small></span><em>{{ project.latestSnapshot?.stats?.included || 0 }} 文件</em></button></div><div class="card project-summary" v-if="currentProject"><div class="card-title"><b>当前项目</b><span class="badge">{{ currentProject.privacyMode === 'local_only' ? '本机只读' : '外部 AI 需授权' }}</span></div><div class="summary-path">{{ currentProject.rootPath }}</div><label class="privacy-toggle"><input type="checkbox" :checked="currentProject.privacyMode === 'external_ai_opt_in'" @change="updatePrivacy" /> 允许本项目把脱敏证据发送给外部 AI</label><div class="metrics"><span><b>{{ scan?.stats?.included || 0 }}</b>纳入文件</span><span><b>{{ scan?.stats?.excluded || 0 }}</b>排除项</span><span><b>{{ graphNodes.length }}</b>图节点</span></div><button class="full-button" @click="startScan">{{ scan ? '重新扫描项目' : '开始扫描项目' }}</button></div></section>
          <section v-else-if="activeSection==='scan'" class="content-grid scan-grid"><div class="card scan-overview"><div class="card-title"><b>扫描快照</b><span class="badge" :class="scan?.status">{{ scan?.status || '未开始' }}</span></div><div class="metrics"><span><b>{{ scan?.stats?.included || 0 }}</b>纳入</span><span><b>{{ scan?.stats?.excluded || 0 }}</b>排除</span><span><b>{{ scan?.stats?.sensitive || 0 }}</b>敏感项</span><span><b>{{ scan?.stats?.bytes ? fmtBytes(scan.stats.bytes) : '—' }}</b>总大小</span></div><button class="primary" @click="startScan" :disabled="!currentProject">扫描当前项目</button></div><div class="card file-card"><div class="card-title"><b>文件清单</b><span class="muted">{{ files.length }} 条</span></div><div class="file-list"><div v-for="file in files" :key="file.relativePath" class="file-row"><span :class="['file-icon', file.included ? 'included' : 'excluded']">{{ file.included ? '✓' : '×' }}</span><span class="file-path">{{ file.relativePath }}</span><span class="file-lang">{{ file.language || file.kind }}</span><span class="file-reason" v-if="!file.included">{{ file.exclusionReason }}</span></div></div></div><div class="card analysis-cta"><span class="eyebrow">EVIDENCE PACK</span><h2>用当前快照生成架构图</h2><p>会先把相对路径、摘要和受预算控制的代码片段整理成 ContextBundle。</p><select v-model="analysisMode"><option value="architecture">架构图</option><option value="workflow">工作流</option><option value="data_flow">数据流</option><option value="sequence">时序</option><option value="lifecycle">生命周期</option></select><textarea v-model="analysisPrompt" rows="4"></textarea><button class="primary full-button" @click="generateArchitecture">开始分析</button></div></section>
          <section v-else-if="activeSection==='architecture'" class="content-grid architecture-grid"><div class="card architecture-header"><div><span class="eyebrow">ARCHITECTURE IR</span><h2>{{ analysis?.document?.diagram?.meta?.title || (graphNodes.length ? '当前架构图' : '等待架构分析') }}</h2><p>{{ analysis?.status === 'succeeded' ? '结果已通过结构化校验并投影到画布。' : analysis?.status === 'running' ? '正在扫描证据并生成图…' : '选择一个已完成扫描的项目开始。' }}</p></div><div class="header-actions"><button class="ghost" @click="openArtifact" :disabled="!analysis?.document">打开 HTML 预览</button><button class="primary" @click="generateArchitecture" :disabled="!scan || scan.status!=='succeeded'">重新生成</button></div></div><div class="card diagram-card"><div class="card-title"><b>架构节点</b><span class="badge">{{ graphNodes.length }} nodes · {{ graphEdges.length }} edges</span></div><div class="diagram-grid"><button v-for="node in graphNodes" :key="node.id" class="diagram-node" @click="selectCanvasNode(node)"><span :class="['node-kind',node.kind]"></span><b>{{ node.label }}</b><small>{{ node.summary || node.kind }}</small><code v-if="node.evidence?.length">{{ node.evidence[0].path }}:{{ node.evidence[0].line || 1 }}</code></button></div></div><div class="card recommendation-card"><div class="card-title"><b>发展建议与证据缺口</b></div><div v-if="analysis?.document?.diagram?.recommendations?.length" class="recommendation" v-for="item in analysis.document.diagram.recommendations" :key="item.id"><span class="priority">{{ item.priority || 'medium' }}</span><b>{{ item.title }}</b><p>{{ item.detail }}</p></div><div v-else class="empty-panel">本地首版图会先给出结构摘要；接入外部 AI 后可以生成更细的建议。</div></div><details class="card raw-card"><summary>查看结构化结果 JSON</summary><pre>{{ analysis ? JSON.stringify(analysis.result || analysis.document?.diagram || analysis, null, 2) : '暂无结果' }}</pre></details></section>
          <section v-else-if="activeSection==='assets'" class="content-grid assets-grid"><div class="card"><div class="card-title"><b>文件与资产</b><label class="search-inline"><span>⌕</span><input v-model="search" placeholder="搜索素材" /></label><label class="upload-button">导入资产<input type="file" multiple @change="importFiles" /></label></div><div class="asset-list phase2-assets"><div v-for="asset in filteredAssets" :key="asset.id" class="asset-card"><div class="asset-thumb">{{ asset.media_type==='image' ? '▧' : '▤' }}</div><div><b>{{ asset.filename }}</b><small>{{ asset.media_type }} · {{ fmtBytes(asset.size) }}</small><div class="tag-line"><span v-for="tag in (asset.tags || []).slice(0,3)" :key="tag" class="tag">{{ tag }}</span></div></div></div><div v-if="!filteredAssets.length" class="empty-panel">还没有已导入资产。</div></div></div><div class="card"><span class="eyebrow">PROJECT FILES</span><h2>当前快照文件</h2><div class="file-list compact"><div v-for="file in includedFiles.slice(0,80)" :key="file.relativePath" class="file-row"><span class="file-icon included">✓</span><span class="file-path">{{ file.relativePath }}</span><span class="file-lang">{{ file.language }}</span></div></div><p class="muted">{{ excludedFiles.length }} 个文件或目录按扫描策略排除。</p></div></section>
          <section v-else-if="activeSection==='canvas'" class="canvas-section"><div class="canvas-toolbar"><span>架构图 / 研究图</span><div><button class="ghost" @click="addCanvasNote">添加笔记</button><button class="primary" @click="saveCanvas">保存画布</button></div></div><div class="canvas-viewport phase2-canvas"><div class="canvas-world"><svg class="edge-layer"><line v-for="edge in graphEdges" :key="edge.id" x1="100" y1="80" x2="500" y2="180" /></svg><button v-for="(node,index) in graphNodes" :key="node.id" class="graph-node phase2-node" :style="{left:(80+(index%3)*300)+'px',top:(70+Math.floor(index/3)*190)+'px'}" @click="selectCanvasNode(node)"><div class="node-head"><span :class="['node-kind',node.kind]"></span><b>{{ node.label }}</b></div><div class="node-body">{{ node.summary || node.kind }}<small v-if="node.evidence?.length">{{ node.evidence[0].path }}:{{ node.evidence[0].line || 1 }}</small></div></button></div><div v-if="!graphNodes.length" class="canvas-empty">扫描项目并生成架构图后，结果会出现在这里。</div></div></section>
          <section v-else-if="activeSection==='workflow'" class="content-grid workflow-grid"><div class="card"><span class="eyebrow">WORKFLOW RUNNER</span><h2>项目上下文任务</h2><p class="muted">运行任务自动复用全项目 Provider，不在这里重复填写 API Key。</p><textarea v-model="runForm.prompt" rows="6" placeholder="例如：总结当前架构的技术债和下一步实验建议"></textarea><button class="primary full-button" @click="runTask">运行并记录</button></div><div class="card"><div class="card-title"><b>最近运行</b><span class="muted">{{ runs.length }} 条</span></div><div v-for="run in runs.slice(0,12)" :key="run.id" class="run-card"><span :class="['run-status',run.status]">● {{ run.status }}</span><p>{{ run.request?.prompt || '无提示' }}</p><small>{{ run.provider }} · {{ fmtDate(run.startedAt) }}</small></div><div v-if="!runs.length" class="empty-panel">还没有运行记录。</div></div></section>
          <section v-else class="content-grid settings-grid"><div class="card"><span class="eyebrow">GLOBAL PROVIDER</span><h2>全项目 API Key</h2><p>Provider 配置会被普通任务和架构分析共同使用。服务端只返回是否已配置，不回显密钥。</p><div class="field"><label>Base URL</label><input v-model="provider.baseUrl" placeholder="留空使用本地演示" /></div><div class="field"><label>模型</label><input v-model="provider.model" /></div><div class="field"><label>API Key <span class="muted">{{ provider.hasApiKey ? '已配置，留空保持不变' : '未配置' }}</span></label><input v-model="provider.apiKey" type="password" placeholder="只在保存时提交" /></div><div class="button-row"><button class="primary" @click="saveProvider">保存 Provider</button><button class="ghost danger" @click="clearProviderKey">清除 API Key</button></div></div><div class="card"><span class="eyebrow">OPEN SOURCE</span><h2>开源声明</h2><p>架构图 IR 适配参考并调用 <a href="https://github.com/tt-a1i/archify" target="_blank" rel="noreferrer">tt-a1i/archify</a> 的验证、渲染和交付思路。</p><p class="muted">MergeGraph 保留独立的本地扫描、证据模型和画布数据。具体许可与 commit 记录见 THIRD_PARTY_NOTICES.md。</p></div></section>
        </div>
      </section>
      <aside class="context-inspector"><div class="inspector-tabs"><b>上下文检查器</b><span class="muted" v-if="canvas.selected">已选择节点</span></div><div v-if="canvas.selected" class="inspector-body"><h2>{{ canvas.selected.label || canvas.selected.data?.title }}</h2><p>{{ canvas.selected.summary || canvas.selected.data?.body || '架构节点' }}</p><div v-if="canvas.selected.evidence?.length" class="evidence-list"><span v-for="item in canvas.selected.evidence" :key="item.path + item.line">{{ item.path }}:{{ item.line || 1 }}</span></div></div><div v-else class="inspector-empty">选择架构节点或文件后，这里显示证据、标签、建议和运行关系。</div></aside>
    </main>
  </div>`
};

createApp(app).mount('#app');
