(() => {
  const STORAGE_KEY = 'megaprep-cms-state-v2';
  const SESSION_KEY = 'megaprep-session-v1';
  const OPENAI_MODEL_STORAGE = 'megaprep-openai-model-v1';
  const CLOUDFLARE_API = (window.MPQM_CLOUDFLARE_API || '').replace(/\/+$/, '');
  const BACKEND = window.MPQM_BACKEND || 'cloudflare';
  const CURRICULUM = window.MEGAPREP_CURRICULUM || {};
  const defaultState = {
    exams: [],
    questions: [],
    students: [],
    attempts: [],
    devices: [],
    credentials: { admins: [], students: [] },
    settings: {
      darkMode: false,
      printConfig: {
        headerTitle: 'MegaPrep Examination',
        examCode: 'EXAM-001',
        classLabel: 'Class 12',
        instructions: 'Answer all questions carefully.',
        durationLabel: '3 Hours',
        marksLabel: '100',
        paperTitle: '',
        paperSubject: '',
        paperDate: '',
        paperType: '',
        leftLogo: '',
        rightLogo: '',
        headerTheme: 'classic',
        numberPrefix: '',
        columns: '1',
        setCount: 4,
        setLabelStyle: 'alphabet',
        showAnswers: false,
        showExplanation: false,
        shuffleQuestions: true,
        shuffleOptions: true,
        includeAnswerSheet: true,
        compactMode: true,
        showTopicHeading: true,
      },
    },
  };

  const state = loadState();
  let analyticsChart;
  let accuracyChart;
  let questionMode = 'mcq';
  let mcqImageData = '';
  let cqImageData = '';
  let selectedQuestionExamId = '';
  let editingQuestionId = '';
  let selectedManageExamId = '';
  let activeManageEditQuestionId = '';
  let livePreviewSelectedSet = '';
  let questionListPage = 1;
  const livePreviewLayouts = new Map();
  let cloudSaveTimer = null;
  let cloudLifecycleBound = false;
  let cloudWorkspaceVersion = 0;
  let supabaseClientPromise = null;
  let openCvPromise = null;
  const QUESTION_LIST_PAGE_SIZE = 50;

  document.addEventListener('DOMContentLoaded', () => { init(); });

  async function init() {
    const currentPage = document.body.dataset.page || '';
    if (currentPage !== 'solution-download') {
      const allowed = await ensureAdminAccess();
      if (!allowed) return;
      if (getSession()?.role === 'admin') {
        bindCloudLifecycleSync();
        await hydrateStateFromCloud();
      }
    }
    bindThemeToggle();
    bindExportImport();
    ensureCurrentDevice();
    renderGlobalMeta();
    switch (document.body.dataset.page) {
      case 'dashboard': initDashboard(); break;
      case 'create-exam': initCreateExamPage(); break;
      case 'question-bank': initQuestionBankPage(); break;
      case 'handle-exams': initHandleExamsPage(); break;
      case 'solution-download': initSolutionDownloadPage(); break;
      case 'students': initStudentsPage(); break;
      case 'result-analyse': initResultAnalysePage(); break;
      case 'scan-omr': initScanOmrPage(); break;
      case 'student-profile': initStudentProfilePage(); break;
      case 'analytics': initAnalyticsPage(); break;
      case 'devices': initDevicesPage(); break;
      case 'passwords': initPasswordsPage(); break;
      default: break;
    }
  }

  async function cloudflareRequest(path, { method = 'GET', body } = {}) {
    if (BACKEND === 'supabase') return supabaseRequest(path, { method, body });
    const session = getSession();
    if (!CLOUDFLARE_API) throw new Error('Cloudflare config missing.');
    if (!session?.token) throw new Error('Login required.');
    const response = await fetch(`${CLOUDFLARE_API}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) throw new Error(data?.error || `Request failed (${response.status})`);
    return data;
  }

  async function supabaseRequest(path, { method = 'GET', body } = {}) {
    const client = await getSupabaseClient();
    if (path === '/auth/session') {
      const { data: userData, error: userError } = await client.auth.getUser();
      if (userError || !userData?.user) throw new Error('Login required.');
      const profile = await getSupabaseProfile(client, userData.user.id);
      return { ok: true, user: profile };
    }
    if (path === '/auth/logout' && method === 'POST') {
      const { error } = await client.auth.signOut();
      if (error) throw error;
      return { ok: true };
    }
    if (path === '/auth/change-password' && method === 'POST') {
      const { data: userData, error: userError } = await client.auth.getUser();
      if (userError || !userData?.user?.email) throw new Error('Login required.');
      const current = body?.current_password || '';
      const next = body?.new_password || '';
      const verify = await client.auth.signInWithPassword({ email: userData.user.email, password: current });
      if (verify.error) throw new Error('Current password incorrect.');
      const { error } = await client.auth.updateUser({ password: next });
      if (error) throw error;
      return { ok: true };
    }
    if (path === '/workspace' && method === 'GET') {
      const { data, error } = await client
        .from('app_settings')
        .select('id, workspace_data, dark_mode, print_config, version, updated_at')
        .eq('id', 1)
        .single();
      if (error) throw error;
      return {
        ok: true,
        data: {
          ...data,
          workspace_data: JSON.stringify(data?.workspace_data || {}),
          print_config: JSON.stringify(data?.print_config || {}),
        },
      };
    }
    if (path === '/workspace' && method === 'PUT') {
      const { data, error } = await client.rpc('save_workspace', {
        p_workspace_data: body?.workspace_data || {},
        p_dark_mode: !!body?.dark_mode,
        p_print_config: body?.print_config || {},
        p_expected_version: body?.version || 0,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (row?.conflict) {
        const err = new Error('Workspace changed on another device. Reload before saving.');
        err.conflict = true;
        err.version = row.version;
        throw err;
      }
      return { ok: true, version: row?.version || 0 };
    }
    if (path === '/profiles/upsert') return { ok: true };
    if (path === '/solutions/publish' && method === 'POST') {
      const { error } = await client.from('published_solutions').upsert({
        exam_id: body.exam_id,
        published: true,
        payload: body.payload || {},
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      return { ok: true };
    }
    if (path === '/solutions/unpublish' && method === 'POST') {
      const { error } = await client
        .from('published_solutions')
        .update({ published: false, updated_at: new Date().toISOString() })
        .eq('exam_id', body.exam_id);
      if (error) throw error;
      return { ok: true };
    }
    throw new Error(`Unsupported Supabase path: ${path}`);
  }

  async function getSupabaseClient() {
    if (supabaseClientPromise) return supabaseClientPromise;
    supabaseClientPromise = (async () => {
      if (!window.supabase?.createClient) await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2');
      const url = window.MPQM_SUPABASE_URL;
      const anonKey = window.MPQM_SUPABASE_ANON_KEY;
      if (!url || !anonKey || /PASTE_/.test(url + anonKey)) throw new Error('Supabase URL/anon key missing in firebase-config.js.');
      return window.supabase.createClient(url, anonKey);
    })();
    return supabaseClientPromise;
  }

  async function getSupabaseProfile(client, userId) {
    const { data, error } = await client.from('profiles').select('*').eq('id', userId).single();
    if (error) throw error;
    return {
      id: data.id,
      role: data.role,
      email: data.email || '',
      student_id: data.student_id || '',
      full_name: data.full_name || '',
    };
  }

  async function ensureAdminAccess() {
    const session = getSession();
    const currentPage = document.body.dataset.page || '';
    const studentPages = new Set(['student-profile']);
    if (!session?.token) {
      window.location.href = studentPages.has(currentPage) ? 'student-login.html' : 'admin-login.html';
      return false;
    }
    try {
      const payload = await cloudflareRequest('/auth/session');
      const role = payload?.user?.role;
      if (studentPages.has(currentPage)) return role === 'student' || role === 'admin';
      if (role !== 'admin') {
        window.location.href = 'admin-login.html';
        return false;
      }
      return true;
    } catch {
      localStorage.removeItem(SESSION_KEY);
      window.location.href = studentPages.has(currentPage) ? 'student-login.html' : 'admin-login.html';
      return false;
    }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? mergeState(JSON.parse(raw)) : structuredClone(defaultState);
    } catch {
      return structuredClone(defaultState);
    }
  }

  function mergeState(saved) {
    return {
      ...structuredClone(defaultState),
      ...saved,
      credentials: { admins: [], students: [] },
      settings: {
        ...structuredClone(defaultState).settings,
        ...(saved.settings || {}),
        printConfig: { ...structuredClone(defaultState).settings.printConfig, ...(saved.settings?.printConfig || {}) },
      },
    };
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    queueCloudStateSave();
  }

  function queueCloudStateSave() {
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer = setTimeout(() => { syncStateToCloud({ retries: 3 }); }, 350);
  }

  function bindCloudLifecycleSync() {
    if (cloudLifecycleBound) return;
    cloudLifecycleBound = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') syncStateToCloud({ retries: 1 });
    });
    window.addEventListener('beforeunload', () => {
      syncStateToCloud({ retries: 1 });
    });
  }

  async function hydrateStateFromCloud() {
    try {
      const payload = await cloudflareRequest('/workspace');
      const row = payload?.data || null;
      cloudWorkspaceVersion = Number(row?.version || 0);
      const cloudData = row?.workspace_data ? JSON.parse(row.workspace_data) : null;
      const localHasData = !!(state.exams?.length || state.questions?.length || state.students?.length || state.attempts?.length);
      if (!cloudData || !Object.keys(cloudData).length) {
        if (localHasData) await syncStateToCloud({ retries: 3 });
        return;
      }
      const merged = mergeState(cloudData);
      Object.keys(state).forEach((key) => { delete state[key]; });
      Object.assign(state, merged);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      console.warn('Cloud hydrate failed. Using local workspace.');
    }
  }

  function buildCloudStateSnapshot(sourceState) {
    const snapshot = JSON.parse(JSON.stringify(sourceState || {}));
    if (Array.isArray(snapshot.attempts)) {
      snapshot.attempts = snapshot.attempts.map((attempt) => ({
        ...attempt,
        omrPreview: '',
        omr_preview: '',
      }));
    }
    let raw = JSON.stringify(snapshot);
    if (raw.length > 4_000_000) {
      throw new Error('Workspace is too large to sync. Export data and move images to external storage before saving.');
    }
    delete snapshot.credentials;
    return snapshot;
  }

  async function syncStateToCloud({ retries = 1 } = {}) {
    let lastError = null;
    let cloudState;
    try {
      cloudState = buildCloudStateSnapshot(state);
    } catch (err) {
      console.warn(err?.message || err);
      showToast?.(err?.message || 'Workspace is too large to sync.', 'error');
      return false;
    }
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        const result = await cloudflareRequest('/workspace', {
          method: 'PUT',
          body: {
            workspace_data: cloudState,
            dark_mode: !!cloudState.settings?.darkMode,
            print_config: cloudState.settings?.printConfig || {},
            version: cloudWorkspaceVersion,
          },
        });
        cloudWorkspaceVersion = Number(result?.version || cloudWorkspaceVersion + 1);
        return true;
      } catch (err) {
        lastError = err;
      }
    }
    try {
      const message = lastError?.message || JSON.stringify(lastError) || 'unknown error';
      console.warn(`Cloud sync failed after retry. Data kept locally. ${message}`);
    } catch {
      console.warn('Cloud sync failed. Data kept locally.');
    }
    return false;
  }
  function getSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } }
  function uid(prefix) { return `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-5)}`; }

  function showToast(message, type = 'success') {
    const stack = document.getElementById('toastStack');
    if (!stack) return;
    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.textContent = message;
    stack.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('is-visible'));
    setTimeout(() => {
      toast.classList.remove('is-visible');
      setTimeout(() => toast.remove(), 250);
    }, 2600);
  }

  function bindThemeToggle() {
    const toggle = document.getElementById('themeToggle');
    if (!toggle) return;
    applyTheme();
    toggle.addEventListener('click', () => {
      state.settings.darkMode = !state.settings.darkMode;
      saveState();
      applyTheme();
      showToast(state.settings.darkMode ? 'Dark mode enabled.' : 'Light mode enabled.');
    });
  }

  function applyTheme() { document.body.classList.toggle('theme-dark', !!state.settings.darkMode); }

  function bindExportImport() {
    const exportBtn = document.getElementById('exportDataBtn');
    const importInput = document.getElementById('importDataFile');
    if (exportBtn) exportBtn.addEventListener('click', exportWorkspace);
    if (importInput) importInput.addEventListener('change', importWorkspace);
  }

  function exportWorkspace() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'megaprep-cms-data.json';
    link.click();
    URL.revokeObjectURL(url);
    showToast('Workspace exported.');
  }

  async function importWorkspace(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const incoming = mergeState(JSON.parse(await file.text()));
      Object.assign(state, incoming);
      saveState();
      window.location.reload();
    } catch {
      showToast('Failed to import workspace.', 'error');
    }
    event.target.value = '';
  }

  function ensureCurrentDevice() {
    const session = getSession();
    if (!session?.deviceId) return;
    const existing = state.devices.find((device) => device.id === session.deviceId);
    if (existing) existing.lastActive = new Date().toISOString();
    else state.devices.unshift({ id: session.deviceId, label: session.label || 'Browser Session', browser: navigator.userAgent, role: session.role, lastActive: new Date().toISOString() });
    saveState();
  }

  function renderGlobalMeta() {
    const sessionBadge = document.getElementById('sessionBadge');
    const storageBadge = document.getElementById('storageBadge');
    const adminNavLink = document.getElementById('navAdminLogin');
    const session = getSession();
    if (sessionBadge) sessionBadge.textContent = session ? `${session.role} session active` : 'No active admin session';
    if (storageBadge) storageBadge.textContent = `${state.exams.length} exams · ${state.questions.length} questions · ${state.students.length} students`;
    if (adminNavLink) {
      if (session?.role === 'admin') {
        adminNavLink.textContent = 'Logout';
        adminNavLink.href = '#';
        adminNavLink.onclick = async (event) => {
          event.preventDefault();
          await logoutAdminSession();
        };
      } else {
        adminNavLink.textContent = 'Admin Login';
        adminNavLink.href = 'admin-login.html';
        adminNavLink.onclick = null;
      }
    }
  }

  async function logoutAdminSession() {
    try {
      await cloudflareRequest('/auth/logout', { method: 'POST' });
    } catch {
      // Session may already be expired; local logout should still continue.
    }
    localStorage.removeItem(SESSION_KEY);
    window.location.href = 'admin-login.html';
  }

  function initDashboard() {
    renderGlobalMeta();
  }

  function initCreateExamPage() {
    bindCurriculumSelectors({ level: 'examLevel', group: 'examGroup', subject: 'examSubject' }, true);
    document.getElementById('addSectionBtn').addEventListener('click', () => document.getElementById('sectionList').appendChild(createSectionRow()));
    resetSectionList();
    const form = document.getElementById('examForm');
    form.addEventListener('submit', handleExamSubmit);
    const editId = new URLSearchParams(window.location.search).get('examId');
    if (editId) loadExamIntoForm(editId);
    renderExamSummary();
  }

  function bindCurriculumSelectors(ids, syncCourse = false, includeAll = true) {
    const level = document.getElementById(ids.level);
    const group = document.getElementById(ids.group);
    const subject = document.getElementById(ids.subject);
    const topic = ids.topic ? document.getElementById(ids.topic) : null;
    if (!level || !group || !subject) return;

    const withAll = (items) => includeAll ? ['<option value="">All</option>'].concat(items.map((item) => `<option value="${item}">${item}</option>`)).join('') : items.map((item) => `<option value="${item}">${item}</option>`).join('');
    const renderGroups = () => {
      level.innerHTML = withAll(Object.keys(CURRICULUM));
      updateGroups();
    };

    const updateGroups = () => {
      const groups = level.value ? Object.keys(CURRICULUM[level.value] || {}) : [...new Set(Object.values(CURRICULUM).flatMap((item) => Object.keys(item || {})))];
      group.innerHTML = withAll(groups);
      updateSubjects();
    };

    const updateSubjects = () => {
      const subjects = level.value && group.value
        ? Object.keys(CURRICULUM[level.value]?.[group.value] || {})
        : level.value
          ? [...new Set(Object.values(CURRICULUM[level.value] || {}).flatMap((item) => Object.keys(item || {})))]
          : [...new Set(Object.values(CURRICULUM).flatMap((lvl) => Object.values(lvl || {}).flatMap((grp) => Object.keys(grp || {}))))];
      subject.innerHTML = withAll(subjects);
      updateTopics();
      if (syncCourse && document.getElementById('examCourse')) document.getElementById('examCourse').value = `${level.value} ${subject.value}`;
    };

    const updateTopics = () => {
      if (!topic) return;
      const topics = level.value && group.value && subject.value
        ? CURRICULUM[level.value]?.[group.value]?.[subject.value] || []
        : level.value && group.value
          ? [...new Set(Object.values(CURRICULUM[level.value]?.[group.value] || {}).flat())]
          : [...new Set(Object.values(CURRICULUM).flatMap((lvl) => Object.values(lvl || {}).flatMap((grp) => Object.values(grp || {}).flat())))];
      topic.innerHTML = withAll(topics);
    };

    level.addEventListener('change', updateGroups);
    group.addEventListener('change', updateSubjects);
    subject.addEventListener('change', updateTopics);
    renderGroups();
  }

  function createSectionRow(section = {}) {
    const row = document.createElement('div');
    row.className = 'section-row';
    row.dataset.id = section.id || uid('section');
    row.innerHTML = `<input data-field="name" type="text" placeholder="Section name" value="${escapeAttr(section.name || '')}" /><input data-field="marks" type="number" min="1" placeholder="Marks per question" value="${escapeAttr(section.marksPerQuestion || '')}" /><button type="button" class="icon-button">Remove</button>`;
    row.querySelector('.icon-button').addEventListener('click', () => row.remove());
    return row;
  }

  function resetSectionList(sections = [{}]) {
    const list = document.getElementById('sectionList');
    if (!list) return;
    list.innerHTML = '';
    sections.forEach((section) => list.appendChild(createSectionRow(section)));
  }

  function handleExamSubmit(event) {
    event.preventDefault();
    const sections = [...document.querySelectorAll('.section-row')].map((row) => ({ id: row.dataset.id, name: row.querySelector('[data-field="name"]').value.trim(), marksPerQuestion: Number(row.querySelector('[data-field="marks"]').value || 0) })).filter((item) => item.name);
    const id = document.getElementById('examId').value || uid('exam');
    const existing = state.exams.find((exam) => exam.id === id);
    const exam = {
      id,
      level: document.getElementById('examLevel').value,
      group: document.getElementById('examGroup').value,
      subject: document.getElementById('examSubject').value,
      version: document.getElementById('examVersion')?.value || 'Bangla',
      course: document.getElementById('examCourse').value.trim(),
      examNumber: document.getElementById('examNumber').value.trim(),
      title: document.getElementById('examTitle').value.trim(),
      duration: Number(document.getElementById('examDuration').value),
      fullMarks: Number(document.getElementById('examMarks').value),
      examType: document.getElementById('examType').value,
      examDate: document.getElementById('examDate').value,
      startTime: document.getElementById('examStartTime').value,
      endTime: document.getElementById('examEndTime').value,
      sections,
      questionIds: existing?.questionIds || [],
      setQuestionMap: existing?.setQuestionMap || {},
      uniqueSetGeneration: !!existing?.uniqueSetGeneration,
      published: existing?.published || false,
      createdAt: existing?.createdAt || new Date().toISOString(),
    };
    upsert(state.exams, exam);
    saveState();
    event.target.reset();
    document.getElementById('examId').value = '';
    resetSectionList();
    bindCurriculumSelectors({ level: 'examLevel', group: 'examGroup', subject: 'examSubject' }, true);
    renderExamSummary();
    showToast('Exam saved.');
  }

  function loadExamIntoForm(id) {
    const exam = state.exams.find((item) => item.id === id);
    if (!exam) return;
    document.getElementById('examId').value = exam.id;
    bindCurriculumSelectors({ level: 'examLevel', group: 'examGroup', subject: 'examSubject' }, true);
    document.getElementById('examLevel').value = exam.level || 'SSC';
    document.getElementById('examLevel').dispatchEvent(new Event('change'));
    document.getElementById('examGroup').value = exam.group || document.getElementById('examGroup').value;
    document.getElementById('examGroup').dispatchEvent(new Event('change'));
    document.getElementById('examSubject').value = exam.subject || document.getElementById('examSubject').value;
    document.getElementById('examVersion').value = exam.version || 'Bangla';
    document.getElementById('examCourse').value = exam.course;
    document.getElementById('examNumber').value = exam.examNumber;
    document.getElementById('examTitle').value = exam.title;
    document.getElementById('examDuration').value = exam.duration;
    document.getElementById('examMarks').value = exam.fullMarks;
    document.getElementById('examType').value = exam.examType;
    document.getElementById('examDate').value = exam.examDate;
    document.getElementById('examStartTime').value = exam.startTime;
    document.getElementById('examEndTime').value = exam.endTime;
    resetSectionList(exam.sections?.length ? exam.sections : [{}]);
  }

  function renderExamSummary() {
    const target = document.getElementById('examSummaryList');
    if (!target) return;
    if (!state.exams.length) return target.innerHTML = emptyState('No exams created yet.');
    target.innerHTML = state.exams.map((exam) => `<article class="entity-card"><div><h4>${escapeHtml(exam.title)}</h4><p>${escapeHtml(exam.level)} · ${escapeHtml(exam.subject)} · ${escapeHtml(exam.version || 'Bangla')} · ${escapeHtml(exam.examDate)}</p></div><a class="toolbar-button" href="create-exam.html?examId=${exam.id}">Edit</a></article>`).join('');
  }

  function initQuestionBankPage() {
    bindCurriculumSelectors({ level: 'qbLevel', group: 'qbGroup', subject: 'qbSubject', topic: 'qbTopic' });
    bindCurriculumFilterSelectors({ level: 'qFilterLevel', group: 'qFilterGroup', subject: 'qFilterSubject', topic: 'qFilterTopic' });
    bindQuestionExamTarget();
    document.getElementById('questionModeTabs').addEventListener('click', switchQuestionMode);
    document.getElementById('addOptionBtn').addEventListener('click', () => { document.getElementById('optionList').appendChild(createOptionRow()); updateOptionIndexes(); updateQuestionPreview(); });
    document.getElementById('addSubQuestionBtn').addEventListener('click', () => { document.getElementById('subQuestionList').appendChild(createSubQuestionRow()); updateQuestionPreview(); });
    document.getElementById('generatePromptBtn').addEventListener('click', generateCurriculumPrompt);
    document.getElementById('applyPromptBtn').addEventListener('click', applyPromptToEditor);
    document.getElementById('openChatGptBtn').addEventListener('click', openChatGptWithPrompt);
    document.getElementById('generateWithAiBtn').addEventListener('click', generateWithChatGptApi);
    document.getElementById('mcqForm').addEventListener('submit', saveMCQ);
    document.getElementById('cqForm').addEventListener('submit', saveCQ);
    document.getElementById('importJsonBtn').addEventListener('click', importQuestionsFromJson);
    document.getElementById('jsonImportText').addEventListener('input', updateQuestionPreview);
    document.getElementById('jsonImportFile').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (file) {
        document.getElementById('jsonImportText').value = await file.text();
        updateQuestionPreview();
      }
    });
    document.getElementById('mcqImage').addEventListener('change', async (e) => { mcqImageData = await readFileAsDataUrl(e.target.files?.[0]); updateQuestionPreview(); });
    document.getElementById('cqImage').addEventListener('change', async (e) => { cqImageData = await readFileAsDataUrl(e.target.files?.[0]); updateQuestionPreview(); });
    document.getElementById('removeMcqImageBtn')?.addEventListener('click', () => {
      mcqImageData = '';
      const input = document.getElementById('mcqImage');
      if (input) input.value = '';
      updateQuestionPreview();
    });
    document.getElementById('removeCqImageBtn')?.addEventListener('click', () => {
      cqImageData = '';
      const input = document.getElementById('cqImage');
      if (input) input.value = '';
      updateQuestionPreview();
    });
    ['mcqQuestion', 'mcqExplanation', 'cqStimulus'].forEach((id) => document.getElementById(id).addEventListener('input', updateQuestionPreview));
    const keyInput = document.getElementById('openaiApiKey');
    const modelInput = document.getElementById('openaiModel');
    if (keyInput) {
      keyInput.value = '';
    }
    if (modelInput) {
      modelInput.value = localStorage.getItem(OPENAI_MODEL_STORAGE) || modelInput.value || 'gpt-4.1-mini';
      modelInput.addEventListener('change', () => localStorage.setItem(OPENAI_MODEL_STORAGE, modelInput.value.trim() || 'gpt-4.1-mini'));
    }
    resetOptions();
    resetSubQuestions();
    const rerenderQuestionsFromFirstPage = () => {
      questionListPage = 1;
      renderQuestions();
    };
    ['qFilterLevel', 'qFilterGroup', 'qFilterSubject', 'qFilterTopic', 'qFilterVersion', 'qFilterType'].forEach((id) => document.getElementById(id)?.addEventListener('change', rerenderQuestionsFromFirstPage));
    document.getElementById('qFilterSearch')?.addEventListener('input', rerenderQuestionsFromFirstPage);
    document.getElementById('qFilterResetBtn')?.addEventListener('click', () => {
      ['qFilterLevel', 'qFilterGroup', 'qFilterSubject', 'qFilterTopic', 'qFilterVersion', 'qFilterType', 'qFilterSearch'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      questionListPage = 1;
      renderQuestions();
    });
    document.getElementById('qDeleteFilteredBtn')?.addEventListener('click', () => {
      const matches = getFilteredQuestionList(getQuestionListFilters());
      if (!matches.length) return showToast('Delete করার মতো filtered question নেই।', 'error');
      if (!window.confirm(`আপনি নিশ্চিত? ${matches.length}টি question permanently delete হবে.`)) return;
      const ids = new Set(matches.map((item) => item.id));
      state.questions = state.questions.filter((item) => !ids.has(item.id));
      state.exams.forEach((exam) => { exam.questionIds = exam.questionIds.filter((id) => !ids.has(id)); });
      saveState();
      questionListPage = 1;
      renderQuestions();
      showToast(`${matches.length}টি question delete হয়েছে।`);
    });
    renderQuestions();
    const query = new URLSearchParams(window.location.search);
    const queryExamId = query.get('examId') || '';
    const editQuestionId = query.get('editQuestionId') || '';
    if (queryExamId) {
      const targetSelect = document.getElementById('qbExamTarget');
      if (targetSelect && [...targetSelect.options].some((option) => option.value === queryExamId)) {
        targetSelect.value = queryExamId;
        selectedQuestionExamId = queryExamId;
      }
    }
    if (editQuestionId) editQuestion(editQuestionId);
    updateQuestionPreview();
  }

  function switchQuestionMode(event) {
    const button = event.target.closest('[data-mode]');
    if (!button) return;
    questionMode = button.dataset.mode;
    document.querySelectorAll('.segmented-control__btn').forEach((item) => item.classList.toggle('is-active', item === button));
    document.querySelectorAll('.mode-panel').forEach((panel) => {
      const active = questionMode === 'json' ? panel.id === 'jsonImportPanel' : panel.id === `${questionMode}Form`;
      panel.classList.toggle('is-active', active);
    });
    updateQuestionPreview();
  }

  function generateCurriculumPrompt() {
    const payload = {
      level: document.getElementById('qbLevel').value,
      group: document.getElementById('qbGroup').value,
      subject: document.getElementById('qbSubject').value,
      topic: document.getElementById('qbTopic').value,
      version: document.getElementById('qbVersion')?.value || 'Bangla',
      questionType: document.getElementById('promptQuestionType').value,
      difficulty: document.getElementById('promptDifficulty').value,
    };
    const languageInstruction = payload.version === 'English'
      ? 'All question text, options, and answers MUST be in English only.'
      : 'সব question text, option, answer এবং explanation অবশ্যই শুদ্ধ বাংলায় হবে।';
    document.getElementById('jsonPromptText').value = `Generate strictly valid JSON for direct import into this Question Bank (copy-পেস্ট ready).\nReturn JSON only. No markdown, no comments, no code fences.\nHard constraints:\n1) Use exactly one root key: {"questions":[ ... ]}\n2) Every question object must include: type, level, group, subject, topic, version\n3) version must be exactly "${payload.version}"\n4) ${languageInstruction}\n5) Do not leave empty strings.\n6) Keep curriculum aligned with:\n   level="${payload.level}", group="${payload.group}", subject="${payload.subject}", topic="${payload.topic}"\n7) Difficulty target: "${payload.difficulty}"\n8) For multiline text use literal \\\\n in JSON (especially CQ answers/explanations).\n9) Math rule (KaTeX-first, strict + auto-fix compatible):
   - Always output inline math with single dollar delimiters: $...$.
   - Use $$...$$ only when a true display block is needed.
   - Do NOT output raw bracket delimiters \(...\) or \[...\] in final JSON.
   - Examples: $x^2 + y^2 = z^2$, $\frac{a}{b}$, $\sqrt{x}$, $\tan^{-1}x$, $\int_0^1 x^2\,dx$.
   - Escape backslashes correctly inside JSON strings (example: $\frac{a}{b}$ in raw JSON text).
   - Never output malformed delimiters like [\...\]; use only $...$ or $$...$$.
   - Never output plain-text math shortcuts like sqrt(x), a/b, x^2 without LaTeX delimiters.
10) Keep wording textbook-like (clean, concise, exam-ready), and keep math notation consistent across question/options/answers/explanations.\n11) Physics Standard Output Instructions:\n   - সকল ভেক্টর রাশিকে \\\\vec{} অথবা \\\\hat{} চিহ্ন দিয়ে প্রকাশ করো (যেমন: \\\\hat{\\\\imath}, \\\\hat{\\\\jmath}, \\\\hat{k}).\n   - একক (Units) লেখার সময় \\\\text{} ব্যবহার করো যেন সেগুলো ইটালিক না হয়ে সোজা থাকে (যেমন: $10 \\\\text{ ms}^{-1}$).\n   - গাণিতিক প্রমাণের ধাপগুলো \\\\therefore, \\\\because এবং \\\\implies চিহ্ন দিয়ে আলাদা করো।\n   - জটিল ভগ্নাংশের ক্ষেত্রে \\\\displaystyle ব্যবহার করো যেন লব ও হর স্পষ্ট বোঝা যায়।\n   - Use \\\\frac{}{} for fractions and always use \\\\left( and \\\\right) to ensure brackets scale correctly with the height of the fractions.\n\nIf questionType is MCQ return exactly this shape:\n{\n  "questions": [\n    {\n      "type": "mcq",\n      "level": "${payload.level}",\n      "group": "${payload.group}",\n      "subject": "${payload.subject}",\n      "topic": "${payload.topic}",\n      "version": "${payload.version}",\n      "section": "${payload.topic}",\n      "question": "single clear stem (KaTeX LaTeX allowed)",\n      "options": ["opt A", "opt B", "opt C", "opt D"],\n      "answer": "A",\n      "explanation": "4-6 short lines with \\\\n separators (KaTeX LaTeX allowed)"\n    }\n  ]\n}\n\nIf questionType is CQ return exactly this shape:\n{\n  "questions": [\n    {\n      "type": "cq",\n      "level": "${payload.level}",\n      "group": "${payload.group}",\n      "subject": "${payload.subject}",\n      "topic": "${payload.topic}",\n      "version": "${payload.version}",\n      "section": "${payload.topic}",\n      "stimulus": "clear passage/context (KaTeX LaTeX allowed)",\n      "subQuestions": [\n        { "label": "A", "prompt": "part A prompt", "answer": "accurate answer A\\\\nsecond line if needed" },\n        { "label": "B", "prompt": "part B prompt", "answer": "accurate answer B\\\\nsecond line if needed" },\n        { "label": "C", "prompt": "part C prompt", "answer": "accurate answer C\\\\nsecond line if needed" }\n      ]\n    }\n  ]\n}\n\nValidation before final output:\n- JSON parses without error\n- MCQ has exactly 4 options\n- answer must be one of A/B/C/D\n- CQ must include at least 2 subQuestions with non-empty prompt+answer\n- Every mathematical expression is wrapped with $...$ (or $$...$$ for display blocks)`;
    showToast('Curriculum prompt generated.');
  }

  function applyPromptToEditor() {
    const raw = document.getElementById('jsonPromptText').value.trim();
    if (!raw) return showToast('Add a prompt or JSON first.', 'error');
    try {
      const payload = JSON.parse(raw);
      const type = (payload.questionType || payload.type || 'MCQ').toUpperCase();
      if (type === 'CQ') {
        questionMode = 'cq';
        document.querySelector('[data-mode="cq"]').click();
        document.getElementById('cqStimulus').value = payload.stimulus || `${payload.subject || document.getElementById('qbSubject').value} - ${payload.topic || document.getElementById('qbTopic').value}`;
      } else {
        questionMode = 'mcq';
        document.querySelector('[data-mode="mcq"]').click();
        document.getElementById('mcqQuestion').value = payload.question || `Create a ${payload.difficulty || 'Medium'} ${payload.subject || document.getElementById('qbSubject').value} question from ${payload.topic || document.getElementById('qbTopic').value}.`;
        document.getElementById('mcqExplanation').value = payload.explanation || '';
        if (Array.isArray(payload.options)) fillOptions(payload.options, payload.correct ?? 0);
      }
      updateQuestionPreview();
      showToast('Prompt applied to editor.');
    } catch {
      document.querySelector('[data-mode="mcq"]').click();
      document.getElementById('mcqQuestion').value = raw;
      updateQuestionPreview();
      showToast('Prompt text applied as question draft.');
    }
  }

  async function openChatGptWithPrompt() {
    const promptArea = document.getElementById('jsonPromptText');
    if (!promptArea) return;
    if (!promptArea.value.trim()) generateCurriculumPrompt();
    const prompt = promptArea.value.trim();
    if (!prompt) return showToast('Generate prompt first.', 'error');
    try {
      await navigator.clipboard.writeText(prompt);
      showToast('Prompt copied. Paste it in ChatGPT to generate question JSON.');
    } catch {
      showToast('Prompt ready. Copy manually and paste in ChatGPT.', 'error');
    }
    window.open('https://chatgpt.com/', '_blank', 'noopener,noreferrer');
  }

  async function generateWithChatGptApi() {
    const promptArea = document.getElementById('jsonPromptText');
    const keyInput = document.getElementById('openaiApiKey');
    const modelInput = document.getElementById('openaiModel');
    if (!promptArea || !keyInput) return;
    if (!promptArea.value.trim()) generateCurriculumPrompt();
    const prompt = promptArea.value.trim();
    const apiKey = keyInput.value.trim();
    const selectedModel = (modelInput?.value || localStorage.getItem(OPENAI_MODEL_STORAGE) || 'gpt-4.1-mini').trim();
    if (!apiKey) return showToast('Add OpenAI API key first.', 'error');
    localStorage.setItem(OPENAI_MODEL_STORAGE, selectedModel);
    try {
      const content = await requestOpenAiJson({ apiKey, prompt, model: selectedModel });
      if (!content) throw new Error('Empty response from OpenAI.');
      document.getElementById('jsonImportText').value = content;
      document.querySelector('[data-mode="json"]')?.click();
      updateQuestionPreview();
      showToast('JSON generated. Review preview, then click Import Questions.');
    } catch (error) {
      showToast(error?.message || 'AI generation failed.', 'error');
    }
  }

  async function requestOpenAiJson({ apiKey, prompt, model }) {
    const tryResponsesApi = async () => {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: [
            { role: 'system', content: [{ type: 'input_text', text: 'Return only valid JSON. No markdown.' }] },
            { role: 'user', content: [{ type: 'input_text', text: prompt }] },
          ],
          text: { format: { type: 'json_object' } },
        }),
      });
      if (!response.ok) throw await createOpenAiHttpError(response);
      const data = await response.json();
      const textFromOutput = Array.isArray(data?.output)
        ? data.output.flatMap((item) => item?.content || []).find((entry) => entry?.type === 'output_text')?.text
        : '';
      return data?.output_text || textFromOutput || '';
    };

    try {
      return await tryResponsesApi();
    } catch (error) {
      const fallbackSafe = /404|unknown endpoint|not found/i.test(error?.message || '');
      if (!fallbackSafe) throw error;
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'Return only valid JSON. No markdown.' },
            { role: 'user', content: prompt },
          ],
        }),
      });
      if (!response.ok) throw await createOpenAiHttpError(response);
      const data = await response.json();
      return data?.choices?.[0]?.message?.content?.trim() || '';
    }
  }

  async function createOpenAiHttpError(response) {
    let details = '';
    try {
      const payload = await response.json();
      details = payload?.error?.message || '';
    } catch {
      details = await response.text();
    }
    return new Error(details ? `OpenAI error ${response.status}: ${details}` : `OpenAI request failed (${response.status}).`);
  }

  function saveMCQ(event) {
    event.preventDefault();
    const options = [...document.querySelectorAll('.option-row')].map((row) => ({ text: row.querySelector('.option-row__text').value.trim(), correct: row.querySelector('.option-row__correct').checked, image: row.dataset.image || '' })).filter((item) => item.text);
    const correct = options.findIndex((item) => item.correct);
    if (!options.length || correct < 0) return showToast('Add options and select the correct answer.', 'error');
    const existing = editingQuestionId ? state.questions.find((item) => item.id === editingQuestionId) : null;
    const question = {
      id: existing?.id || uid('question'),
      type: 'mcq',
      level: document.getElementById('qbLevel').value,
      group: document.getElementById('qbGroup').value,
      subject: document.getElementById('qbSubject').value,
      topic: document.getElementById('qbTopic').value,
      version: document.getElementById('qbVersion')?.value || 'Bangla',
      section: document.getElementById('qbTopic').value,
      question: document.getElementById('mcqQuestion').value.trim(),
      options: options.map((item) => item.text),
      optionImages: options.map((item) => item.image || ''),
      correct,
      explanation: document.getElementById('mcqExplanation').value.trim(),
      image: mcqImageData,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    upsert(state.questions, question);
    if (!existing) linkQuestionToSelectedExam(question.id);
    saveState();
    event.target.reset();
    mcqImageData = '';
    clearQuestionEditingState();
    bindCurriculumSelectors({ level: 'qbLevel', group: 'qbGroup', subject: 'qbSubject', topic: 'qbTopic' });
    resetOptions();
    renderQuestions();
    updateQuestionPreview();
    showToast(existing ? 'MCQ updated.' : (selectedQuestionExamId ? 'MCQ saved and linked to selected exam.' : 'MCQ saved.'));
  }

  function saveCQ(event) {
    event.preventDefault();
    const subQuestions = [...document.querySelectorAll('.sub-question-row')].map((row) => ({ label: row.querySelector('.sub-question-row__label').value.trim(), prompt: row.querySelector('.sub-question-row__prompt').value.trim(), answer: row.querySelector('.sub-question-row__answer').value.trim() })).filter((item) => item.prompt);
    const existing = editingQuestionId ? state.questions.find((item) => item.id === editingQuestionId) : null;
    const question = {
      id: existing?.id || uid('question'),
      type: 'cq',
      level: document.getElementById('qbLevel').value,
      group: document.getElementById('qbGroup').value,
      subject: document.getElementById('qbSubject').value,
      topic: document.getElementById('qbTopic').value,
      version: document.getElementById('qbVersion')?.value || 'Bangla',
      section: document.getElementById('qbTopic').value,
      stimulus: document.getElementById('cqStimulus').value.trim(),
      subQuestions,
      image: cqImageData,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    upsert(state.questions, question);
    if (!existing) linkQuestionToSelectedExam(question.id);
    saveState();
    event.target.reset();
    cqImageData = '';
    clearQuestionEditingState();
    bindCurriculumSelectors({ level: 'qbLevel', group: 'qbGroup', subject: 'qbSubject', topic: 'qbTopic' });
    resetSubQuestions();
    renderQuestions();
    updateQuestionPreview();
    showToast(existing ? 'CQ updated.' : (selectedQuestionExamId ? 'CQ saved and linked to selected exam.' : 'CQ saved.'));
  }

  function importQuestionsFromJson() {
    const message = document.getElementById('jsonImportMessage');
    const raw = document.getElementById('jsonImportText').value.trim();
    if (!raw) {
      message.textContent = 'Paste JSON first.';
      return showToast('Please paste JSON before importing.', 'error');
    }

    try {
      const payload = parseJsonImportPayload(raw);
      const defaults = {
        level: document.getElementById('qbLevel').value,
        group: document.getElementById('qbGroup').value,
        subject: document.getElementById('qbSubject').value,
        topic: document.getElementById('qbTopic').value,
        version: document.getElementById('qbVersion')?.value || 'Bangla',
      };
      const importMeta = {
        partWise: !!document.getElementById('jsonImportPartWise')?.checked,
        defaultPart: String(document.getElementById('jsonImportDefaultPart')?.value || '').trim(),
      };
      const items = Array.isArray(payload)
        ? payload
        : Array.isArray(payload.questions)
          ? payload.questions
          : Array.isArray(payload.data?.questions)
            ? payload.data.questions
            : Array.isArray(payload.result?.questions)
              ? payload.result.questions
              : Array.isArray(payload.output)
                ? payload.output
                : Array.isArray(payload.mcq)
                  ? payload.mcq
                  : Array.isArray(payload.items)
                    ? payload.items
                    : payload.question
                      ? [payload.question]
                      : payload.questions === undefined && typeof payload === 'object'
                        ? [payload]
                        : [];
      if (!items.length) throw new Error('No valid question payload found.');

      const summary = { imported: 0, skipped: 0 };
      items.forEach((question) => {
        const normalized = normalizeImportedQuestion(question, defaults, importMeta);
        if (!normalized) {
          summary.skipped += 1;
          return;
        }
        state.questions.unshift(normalized);
        linkQuestionToSelectedExam(normalized.id);
        summary.imported += 1;
      });

      if (!summary.imported) throw new Error('No valid question entries.');
      saveState();
      clearQuestionEditingState();
      renderQuestions();
      updateQuestionPreview();
      message.textContent = `Imported ${summary.imported} question(s)${summary.skipped ? `, skipped ${summary.skipped}.` : '.'}`;
      showToast(`JSON import complete (${summary.imported} added).`);
    } catch (error) {
      message.textContent = error?.message || 'Invalid JSON format.';
      showToast('JSON validation failed.', 'error');
    }
  }

  function parseJsonImportPayload(raw) {
    const normalizeUnsafeBackslashes = (text) => {
      const input = String(text || '');
      let out = '';
      let inString = false;
      let escaped = false;
      for (let i = 0; i < input.length; i += 1) {
        const ch = input[i];
        if (!inString) {
          if (ch === '"') inString = true;
          out += ch;
          escaped = false;
          continue;
        }
        if (escaped) {
          out += ch;
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          const next = input[i + 1] || '';
          const unicodeSeq = next === 'u' && /^[0-9a-fA-F]{4}$/.test(input.slice(i + 2, i + 6));
          const safeJsonEscape = next === '"' || next === '\\' || next === '/' || unicodeSeq;
          if (safeJsonEscape) {
            out += ch;
            escaped = true;
          } else {
            out += '\\\\';
          }
          continue;
        }
        if (ch === '"') inString = false;
        out += ch;
      }
      return out;
    };
    const normalizeEscapedLayout = (text) => String(text || '').replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
    const repairUnescapedInnerQuotes = (text) => {
      const input = String(text || '');
      let out = '';
      let inString = false;
      let escaped = false;
      for (let i = 0; i < input.length; i += 1) {
        const ch = input[i];
        if (!inString) {
          if (ch === '"') inString = true;
          out += ch;
          escaped = false;
          continue;
        }
        if (escaped) {
          out += ch;
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          out += ch;
          escaped = true;
          continue;
        }
        if (ch === '"') {
          const tail = input.slice(i + 1);
          const nextNonWs = (tail.match(/\S/) || [''])[0];
          const isCloser = !nextNonWs || [',', '}', ']', ':'].includes(nextNonWs);
          if (isCloser) {
            inString = false;
            out += ch;
          } else {
            out += '\\"';
          }
          continue;
        }
        out += ch;
      }
      return out;
    };
    const collectQuestions = (value) => {
      if (!value || typeof value !== 'object') return [];
      if (Array.isArray(value)) return value;
      if (Array.isArray(value.questions)) return value.questions;
      if (Array.isArray(value.data?.questions)) return value.data.questions;
      if (Array.isArray(value.result?.questions)) return value.result.questions;
      if (Array.isArray(value.output)) return value.output;
      if (Array.isArray(value.mcq)) return value.mcq;
      if (Array.isArray(value.items)) return value.items;
      if (value.question && typeof value.question === 'object') return [value.question];
      return [];
    };
    const parseConcatenatedJson = (text) => {
      const source = String(text || '').trim();
      if (!source) return null;
      const blocks = [];
      let depth = 0;
      let start = -1;
      let inString = false;
      let escaped = false;
      for (let i = 0; i < source.length; i += 1) {
        const ch = source[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === '{' || ch === '[') {
          if (depth === 0) start = i;
          depth += 1;
        } else if (ch === '}' || ch === ']') {
          depth -= 1;
          if (depth === 0 && start >= 0) {
            blocks.push(source.slice(start, i + 1));
            start = -1;
          }
        }
      }
      if (blocks.length < 2) return null;
      const parsed = blocks.map((chunk) => JSON.parse(chunk));
      const mergedQuestions = parsed.flatMap((item) => collectQuestions(item));
      if (mergedQuestions.length) return { questions: mergedQuestions };
      return parsed[0];
    };
    const unwrap = (value) => {
      if (value && typeof value === 'object' && typeof value.response === 'string') return value.response.trim();
      if (value && typeof value === 'object' && typeof value.output_text === 'string') return value.output_text.trim();
      return value;
    };
    const parseFromString = (text) => {
      const cleaned = String(text || '')
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/i, '')
        .trim()
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/,\s*([}\]])/g, '$1');
      const normalizedLayout = normalizeEscapedLayout(cleaned);
      const normalized = normalizeUnsafeBackslashes(normalizedLayout);
      try {
        return JSON.parse(normalized);
      } catch {
        if (normalized.startsWith('"') && normalized.endsWith('"')) {
          try {
            const decoded = JSON.parse(normalized);
            if (typeof decoded === 'string') return parseFromString(decoded);
          } catch {
            // continue with fallback parsing below
          }
        }
        const repairedQuotes = repairUnescapedInnerQuotes(normalized);
        try {
          return JSON.parse(repairedQuotes);
        } catch {
          const multi = parseConcatenatedJson(repairedQuotes);
          if (multi) return multi;
        }
        const startObject = repairedQuotes.indexOf('{');
        const startArray = repairedQuotes.indexOf('[');
        const start = startArray >= 0 && (startArray < startObject || startObject < 0) ? startArray : startObject;
        const end = Math.max(repairedQuotes.lastIndexOf('}'), repairedQuotes.lastIndexOf(']'));
        if (start >= 0 && end > start) return JSON.parse(repairedQuotes.slice(start, end + 1));
        throw new Error('Invalid JSON format.');
      }
    };

    try {
      return unwrap(parseFromString(raw));
    } catch {
      const parsed = parseFromString(raw);
      const unwrapped = unwrap(parsed);
      if (typeof unwrapped === 'string') return parseFromString(unwrapped);
      return unwrapped;
    }
  }

  function bindQuestionExamTarget() {
    const select = document.getElementById('qbExamTarget');
    if (!select) return;
    const current = selectedQuestionExamId;
    const options = ['<option value="">Only save in Question Bank</option>'].concat(
      state.exams.map((exam) => `<option value="${exam.id}">${escapeHtml(exam.title)} · ${escapeHtml(exam.subject || '')}</option>`),
    );
    select.innerHTML = options.join('');
    if (state.exams.some((exam) => exam.id === current)) select.value = current;
    select.addEventListener('change', () => { selectedQuestionExamId = select.value; });
    selectedQuestionExamId = select.value;
  }

  function linkQuestionToSelectedExam(questionId) {
    if (!selectedQuestionExamId) return;
    const exam = findExam(selectedQuestionExamId);
    if (!exam) return;
    exam.questionIds = [...new Set([...(exam.questionIds || []), questionId])];
  }

  function normalizeImportedQuestion(question, defaults, meta = {}) {
    if (!question || typeof question !== 'object') return null;
    const level = String(question.level || defaults.level || '').trim();
    const group = String(question.group || defaults.group || '').trim();
    const subject = resolveCurriculumSubject(level, group, String(question.subject || defaults.subject || '').trim());
    const rawTopic = String(question.topic || question.chapter || question.chapterName || question.chaptor || defaults.topic || '').trim();
    const topic = resolveCurriculumTopic(level, group, subject, rawTopic);
    const version = String(question.version || defaults.version || 'Bangla').trim() || 'Bangla';
    const type = String(question.type || (question.stimulus ? 'cq' : 'mcq')).toLowerCase();
    const partLabel = String(question.part || question.section || (meta.partWise ? (meta.defaultPart || subject || topic || '') : '')).trim();
    if (type === 'cq') {
      const rawSubQuestions = Array.isArray(question.subQuestions)
        ? question.subQuestions
        : Array.isArray(question.sub_questions)
          ? question.sub_questions
          : Array.isArray(question.parts)
            ? question.parts
            : Array.isArray(question.questions)
              ? question.questions
              : [];
      const subQuestions = rawSubQuestions.filter((item) => item && (item.prompt || item.question || item.answer || item.modelAnswer || item.label || item.part));
      const stimulus = String(question.stimulus || question.question || '').trim();
      if (!stimulus && !subQuestions.length) return null;
      return {
        id: uid('question'),
        type: 'cq',
        level,
        group,
        subject,
        topic,
        version,
        section: partLabel || question.section || topic || defaults.topic,
        partTagged: !!meta.partWise,
        stimulus,
        subQuestions: subQuestions.map((item, index) => ({
          label: String(item.label || item.part || String.fromCharCode(65 + index)).trim(),
          prompt: String(item.prompt || item.question || '').trim(),
          answer: String(item.answer || item.modelAnswer || item.sampleAnswer || '').trim(),
        })),
        image: question.image || '',
        createdAt: new Date().toISOString(),
        importedAt: new Date().toISOString(),
      };
    }

    const rawOptions = Array.isArray(question.options)
      ? question.options
      : question.options && typeof question.options === 'object'
        ? Object.keys(question.options)
          .sort()
          .map((key) => question.options[key])
        : [];
    const options = rawOptions.length
      ? rawOptions.map((option) => (typeof option === 'string' ? option : option?.text || option?.option || '')).map((option) => String(option).trim()).filter(Boolean)
      : [question.optionA, question.optionB, question.optionC, question.optionD].map((option) => String(option || '').trim()).filter(Boolean);
    const finalOptions = options.length
      ? options
      : [];
    const text = String(question.question || question.stem || '').trim();
    if (!text || !finalOptions.length) return null;
    const correct = normalizeCorrectIndex(
      question.correct,
      question.answer || question.correctAnswer || question.correct_option || question.correctOption || question.ans,
      finalOptions,
    );
    const optionImages = Array.isArray(question.optionImages) ? question.optionImages.map((item) => String(item || '')) : [];
    return {
      id: uid('question'),
      type: 'mcq',
      level,
      group,
      subject,
      topic,
      version,
      section: partLabel || question.section || topic || defaults.topic,
      partTagged: !!meta.partWise,
      question: text,
      options: finalOptions,
      optionImages,
      correct,
      explanation: String(question.explanation || '').trim(),
      image: question.image || '',
      createdAt: new Date().toISOString(),
      importedAt: new Date().toISOString(),
    };
  }

  function resolveCurriculumSubject(level, group, subject) {
    const subjects = Object.keys(CURRICULUM?.[level]?.[group] || {});
    if (!subject || !subjects.length) return subject;
    return subjects.find((item) => item.toLowerCase() === subject.toLowerCase()) || subject;
  }

  function resolveCurriculumTopic(level, group, subject, topic) {
    const topics = CURRICULUM?.[level]?.[group]?.[subject] || [];
    if (!topic || !topics.length) return topic;
    const normalizedTopic = topic.toLowerCase().replace(/\s+/g, ' ').trim();
    return topics.find((item) => item.toLowerCase().replace(/\s+/g, ' ').trim() === normalizedTopic) || topic;
  }

  function normalizeCorrectIndex(correct, answer, options) {
    if (Number.isInteger(correct) && correct >= 0 && correct < options.length) return correct;
    const raw = String(answer || '').trim();
    if (!raw) return 0;
    if (/^\d+$/.test(raw)) {
      const idx = Number(raw) - 1;
      if (idx >= 0 && idx < options.length) return idx;
    }
    const code = raw.toUpperCase().charCodeAt(0) - 65;
    if (code >= 0 && code < options.length) return code;
    const byText = options.findIndex((option) => option.toLowerCase() === raw.toLowerCase());
    return byText >= 0 ? byText : 0;
  }

  function createOptionRow(option = {}) {
    const row = document.createElement('div');
    row.className = 'option-row';
    row.dataset.image = option.image || '';
    row.innerHTML = `<span class="option-row__index"></span><input class="option-row__text" type="text" placeholder="Option text" value="${escapeAttr(option.text || '')}" /><label class="option-row__flag"><input class="option-row__correct" type="radio" name="correctOption" ${option.correct ? 'checked' : ''} /> Correct</label><label class="toolbar-button toolbar-button--file">Option Image<input class="option-row__image" type="file" accept="image/*" hidden /></label><button type="button" class="toolbar-button option-row__image-remove">Remove Image</button><button type="button" class="icon-button">Remove</button><div class="option-row__image-preview">${option.image ? `<img src="${option.image}" alt="Option image" style="max-height:70px;max-width:120px;object-fit:contain;border:1px solid #d8dee9;border-radius:6px;" />` : ''}</div>`;
    row.querySelector('.icon-button').addEventListener('click', () => { row.remove(); updateOptionIndexes(); updateQuestionPreview(); });
    row.querySelector('.option-row__image')?.addEventListener('change', async (event) => {
      const image = await readFileAsDataUrl(event.target.files?.[0]);
      row.dataset.image = image || '';
      row.querySelector('.option-row__image-preview').innerHTML = image ? `<img src="${image}" alt="Option image" style="max-height:70px;max-width:120px;object-fit:contain;border:1px solid #d8dee9;border-radius:6px;" />` : '';
      updateQuestionPreview();
    });
    row.querySelector('.option-row__image-remove')?.addEventListener('click', () => {
      row.dataset.image = '';
      const input = row.querySelector('.option-row__image');
      if (input) input.value = '';
      row.querySelector('.option-row__image-preview').innerHTML = '';
      updateQuestionPreview();
    });
    row.querySelectorAll('input').forEach((el) => el.addEventListener('input', updateQuestionPreview));
    return row;
  }

  function resetOptions() { const list = document.getElementById('optionList'); if (!list) return; list.innerHTML = ''; for (let i = 0; i < 4; i += 1) list.appendChild(createOptionRow()); updateOptionIndexes(); }
  function fillOptions(options, correctIndex, optionImages = []) { const list = document.getElementById('optionList'); list.innerHTML = ''; options.forEach((text, index) => list.appendChild(createOptionRow({ text, correct: index === correctIndex, image: optionImages[index] || '' }))); updateOptionIndexes(); }
  function updateOptionIndexes() { document.querySelectorAll('.option-row').forEach((row, i) => row.querySelector('.option-row__index').textContent = String.fromCharCode(65 + i)); }
  function createSubQuestionRow(item = {}) { const row = document.createElement('div'); row.className = 'sub-question-row'; row.innerHTML = `<input class="sub-question-row__label" type="text" placeholder="Label" value="${escapeAttr(item.label || '')}" /><textarea class="sub-question-row__prompt" rows="2" placeholder="Sub question">${escapeHtml(item.prompt || '')}</textarea><textarea class="sub-question-row__answer" rows="2" placeholder="Answer">${escapeHtml(item.answer || '')}</textarea><button type="button" class="toolbar-button sub-question-row__clear-label">Clear Label</button><button type="button" class="icon-button">Remove</button>`; row.querySelector('.icon-button').addEventListener('click', () => { row.remove(); updateQuestionPreview(); }); row.querySelector('.sub-question-row__clear-label')?.addEventListener('click', () => { const label = row.querySelector('.sub-question-row__label'); if (label) label.value = ''; updateQuestionPreview(); }); row.querySelectorAll('input,textarea').forEach((el) => el.addEventListener('input', updateQuestionPreview)); return row; }
  function resetSubQuestions() { const list = document.getElementById('subQuestionList'); if (!list) return; list.innerHTML = ''; ['A', 'B'].forEach((label) => list.appendChild(createSubQuestionRow({ label }))); }

  function updateQuestionPreview() {
    const preview = document.getElementById('questionPreview');
    if (!preview) return;
    if (questionMode === 'cq') {
      const subs = [...document.querySelectorAll('.sub-question-row')].map((row) => `<div class="preview-sub"><strong>${escapeHtml(row.querySelector('.sub-question-row__label').value || '')}${row.querySelector('.sub-question-row__label').value ? '.' : ''}</strong> ${formatMathForDisplay(row.querySelector('.sub-question-row__prompt').value || '')}</div>`).join('');
      preview.innerHTML = `<div class="preview-block"><h4>${formatMathForDisplay(document.getElementById('cqStimulus').value || 'Stimulus preview')}</h4>${cqImageData ? `<img class="preview-image" src="${cqImageData}" alt="Stimulus" />` : ''}${subs || '<p>Add sub questions to preview.</p>'}</div>`;
    } else if (questionMode === 'json') {
      const jsonPreview = buildJsonPreviewMarkup(document.getElementById('jsonImportText')?.value || '');
      preview.innerHTML = jsonPreview;
    } else {
      const options = [...document.querySelectorAll('.option-row')].map((row, index) => {
        const text = row.querySelector('.option-row__text').value.trim();
        if (!text) return '';
        const image = row.dataset.image || '';
        return `<li>${String.fromCharCode(65 + index)}. ${formatMathForDisplay(text)}${image ? `<div><img src="${image}" alt="Option ${index + 1}" style="max-height:54px;max-width:120px;object-fit:contain;border:1px solid #d8dee9;border-radius:6px;" /></div>` : ''}</li>`;
      }).join('');
      preview.innerHTML = `<div class="preview-block"><h4>${formatMathForDisplay(document.getElementById('mcqQuestion').value || 'Question preview')}</h4>${mcqImageData ? `<img class="preview-image" src="${mcqImageData}" alt="Question" />` : ''}<ol>${options || '<li>Add options to preview.</li>'}</ol><p>${formatMathForDisplay(document.getElementById('mcqExplanation').value || '')}</p></div>`;
    }
    queueTypeset();
  }

  function renderQuestions() {
    const target = document.getElementById('questionList');
    const pagination = document.getElementById('questionListPagination');
    if (!target) return;
    const filters = getQuestionListFilters();
    const filtered = getFilteredQuestionList(filters);
    updateQuestionFilterSummary(filtered.length, state.questions.length);
    if (!state.questions.length) {
      target.innerHTML = emptyState('No questions created yet.');
      if (pagination) pagination.innerHTML = '';
      return;
    }
    if (!filtered.length) {
      target.innerHTML = emptyState('No saved question matched current filters.');
      if (pagination) pagination.innerHTML = '';
      return;
    }
    const totalPages = Math.max(1, Math.ceil(filtered.length / QUESTION_LIST_PAGE_SIZE));
    questionListPage = Math.max(1, Math.min(questionListPage, totalPages));
    const startIndex = (questionListPage - 1) * QUESTION_LIST_PAGE_SIZE;
    const pageItems = filtered.slice(startIndex, startIndex + QUESTION_LIST_PAGE_SIZE);
    target.innerHTML = pageItems.map((question) => {
      const type = String(question.type || 'mcq').toLowerCase();
      const meta = `${escapeHtml(question.level || '')} · ${escapeHtml(question.group || '')} · ${escapeHtml(question.subject || '')} · ${escapeHtml(question.topic || '')} · ${escapeHtml(question.version || 'Bangla')}`;
      const body = type === 'cq'
        ? `<div><p>${formatMathForDisplay(question.stimulus || question.question || 'CQ question')}</p><ul>${(question.subQuestions || []).map((item) => `<li><strong>${escapeHtml(item.label || '')}${item.label ? '.' : ''}</strong> ${formatMathForDisplay(item.prompt || '')}<br/><span class="muted-copy">Answer: ${formatExplanationForDisplay(item.answer || '')}</span></li>`).join('') || '<li>No sub-question found.</li>'}</ul></div>`
        : `<div><p>${formatMathForDisplay(question.question || 'MCQ question')}</p><ul>${(question.options || []).map((opt, index) => `<li>${String.fromCharCode(65 + index)}. ${formatMathForDisplay(opt || '')}${index === Number(question.correct || 0) ? ' <strong>(Correct)</strong>' : ''}</li>`).join('') || '<li>No option found.</li>'}</ul>${question.explanation ? `<p class="muted-copy"><strong>Explanation:</strong> ${formatExplanationForDisplay(question.explanation)}</p>` : ''}</div>`;
      return `<article class="entity-card entity-card--stacked"><div class="entity-card__head"><div><h4>${escapeHtml(type.toUpperCase())}</h4><p class="muted-copy">${meta}</p></div><div class="entity-actions"><button class="toolbar-button" data-edit-question="${question.id}">Edit</button><button class="toolbar-button toolbar-button--danger" data-delete-question="${question.id}">Delete</button></div></div>${body}</article>`;
    }).join('');
    target.querySelectorAll('[data-edit-question]').forEach((button) => button.addEventListener('click', () => startQuestionEdit(button.dataset.editQuestion)));
    target.querySelectorAll('[data-delete-question]').forEach((button) => button.addEventListener('click', () => {
      state.questions = state.questions.filter((item) => item.id !== button.dataset.deleteQuestion);
      state.exams.forEach((exam) => exam.questionIds = exam.questionIds.filter((id) => id !== button.dataset.deleteQuestion));
      saveState();
      if (editingQuestionId === button.dataset.deleteQuestion) clearQuestionEditingState();
      renderQuestions();
      updateQuestionPreview();
      showToast('Question deleted.');
    }));
    if (pagination) {
      if (totalPages <= 1) {
        pagination.innerHTML = '';
      } else {
        const startPage = Math.max(1, questionListPage - 2);
        const endPage = Math.min(totalPages, startPage + 4);
        const pages = [];
        for (let page = startPage; page <= endPage; page += 1) {
          pages.push(`<button type="button" class="toolbar-button ${page === questionListPage ? 'toolbar-button--solid' : ''}" data-q-page="${page}">${page}</button>`);
        }
        pagination.innerHTML = `<div class="entity-actions"><button type="button" class="toolbar-button" data-q-nav="prev" ${questionListPage === 1 ? 'disabled' : ''}>Prev</button>${pages.join('')}<button type="button" class="toolbar-button" data-q-nav="next" ${questionListPage === totalPages ? 'disabled' : ''}>Next</button><span class="muted-copy">Page ${questionListPage} / ${totalPages}</span></div>`;
        pagination.querySelectorAll('[data-q-page]').forEach((button) => button.addEventListener('click', () => {
          questionListPage = Number(button.dataset.qPage || 1);
          renderQuestions();
        }));
        pagination.querySelector('[data-q-nav="prev"]')?.addEventListener('click', () => {
          if (questionListPage <= 1) return;
          questionListPage -= 1;
          renderQuestions();
        });
        pagination.querySelector('[data-q-nav="next"]')?.addEventListener('click', () => {
          if (questionListPage >= totalPages) return;
          questionListPage += 1;
          renderQuestions();
        });
      }
    }
    queueTypeset();
  }

  function updateQuestionFilterSummary(filteredCount, totalCount) {
    const summary = document.getElementById('qFilterResultCount');
    if (!summary) return;
    const safeFiltered = Number.isFinite(filteredCount) ? filteredCount : 0;
    const safeTotal = Number.isFinite(totalCount) ? totalCount : 0;
    summary.textContent = `Showing ${safeFiltered} of ${safeTotal} question${safeTotal === 1 ? '' : 's'}`;
  }

  function getQuestionListFilters() {
    return {
      level: document.getElementById('qFilterLevel')?.value || '',
      group: document.getElementById('qFilterGroup')?.value || '',
      subject: document.getElementById('qFilterSubject')?.value || '',
      topic: document.getElementById('qFilterTopic')?.value || '',
      version: document.getElementById('qFilterVersion')?.value || '',
      type: (document.getElementById('qFilterType')?.value || '').toLowerCase(),
      query: (document.getElementById('qFilterSearch')?.value || '').trim().toLowerCase(),
    };
  }

  function getFilteredQuestionList(filters = getQuestionListFilters()) {
    const ordered = [...state.questions].sort((a, b) => {
      const importedDiff = new Date(b.importedAt || 0).getTime() - new Date(a.importedAt || 0).getTime();
      if (importedDiff !== 0) return importedDiff;
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    });
    return ordered.filter((question) => {
      if (filters.level && question.level !== filters.level) return false;
      if (filters.group && question.group !== filters.group) return false;
      if (filters.subject && question.subject !== filters.subject) return false;
      if (filters.topic && question.topic !== filters.topic) return false;
      if (filters.version && String(question.version || 'Bangla') !== filters.version) return false;
      if (filters.type && String(question.type || 'mcq').toLowerCase() !== filters.type) return false;
      if (!filters.query) return true;
      const queryBag = [
        question.question, question.stimulus, question.explanation, question.level, question.group, question.subject, question.topic, question.section, question.version,
        ...(question.options || []),
        ...(question.subQuestions || []).flatMap((item) => [item?.label, item?.prompt, item?.answer]),
      ].map((item) => String(item || '').toLowerCase());
      return queryBag.some((item) => item.includes(filters.query));
    });
  }

  function clearQuestionEditingState() {
    editingQuestionId = '';
    const mcqSubmit = document.querySelector('#mcqForm .submit-button');
    const cqSubmit = document.querySelector('#cqForm .submit-button');
    if (mcqSubmit) mcqSubmit.textContent = 'Save MCQ';
    if (cqSubmit) cqSubmit.textContent = 'Save CQ';
  }

  function startQuestionEdit(questionId) {
    const question = state.questions.find((item) => item.id === questionId);
    if (!question) return;
    editingQuestionId = question.id;
    bindCurriculumSelectors({ level: 'qbLevel', group: 'qbGroup', subject: 'qbSubject', topic: 'qbTopic' });
    document.getElementById('qbLevel').value = question.level || document.getElementById('qbLevel').value;
    document.getElementById('qbLevel').dispatchEvent(new Event('change'));
    document.getElementById('qbGroup').value = question.group || document.getElementById('qbGroup').value;
    document.getElementById('qbGroup').dispatchEvent(new Event('change'));
    document.getElementById('qbSubject').value = question.subject || document.getElementById('qbSubject').value;
    document.getElementById('qbSubject').dispatchEvent(new Event('change'));
    document.getElementById('qbTopic').value = question.topic || document.getElementById('qbTopic').value;
    const versionInput = document.getElementById('qbVersion');
    if (versionInput) versionInput.value = question.version || 'Bangla';

    if ((question.type || 'mcq') === 'cq') {
      document.querySelector('[data-mode="cq"]').click();
      document.getElementById('cqStimulus').value = question.stimulus || '';
      cqImageData = question.image || '';
      const list = document.getElementById('subQuestionList');
      list.innerHTML = '';
      (question.subQuestions?.length ? question.subQuestions : [{ label: 'A' }, { label: 'B' }]).forEach((item) => list.appendChild(createSubQuestionRow(item)));
      const cqSubmit = document.querySelector('#cqForm .submit-button');
      if (cqSubmit) cqSubmit.textContent = 'Update CQ';
    } else {
      document.querySelector('[data-mode="mcq"]').click();
      document.getElementById('mcqQuestion').value = question.question || '';
      document.getElementById('mcqExplanation').value = question.explanation || '';
      mcqImageData = question.image || '';
      fillOptions(question.options || [], question.correct ?? 0, question.optionImages || []);
      const mcqSubmit = document.querySelector('#mcqForm .submit-button');
      if (mcqSubmit) mcqSubmit.textContent = 'Update MCQ';
    }
    showToast('Question loaded for editing.');
    updateQuestionPreview();
  }

  function buildJsonPreviewMarkup(raw) {
    if (!String(raw || '').trim()) {
      return '<div class="preview-block"><p>Paste JSON to preview questions and answers before import.</p></div>';
    }
    try {
      const payload = parseJsonImportPayload(raw);
      const defaults = {
        level: document.getElementById('qbLevel')?.value || '',
        group: document.getElementById('qbGroup')?.value || '',
        subject: document.getElementById('qbSubject')?.value || '',
        topic: document.getElementById('qbTopic')?.value || '',
      };
      const items = Array.isArray(payload)
        ? payload
        : Array.isArray(payload.questions)
          ? payload.questions
          : Array.isArray(payload.data?.questions)
            ? payload.data.questions
            : Array.isArray(payload.result?.questions)
              ? payload.result.questions
              : Array.isArray(payload.output)
                ? payload.output
                : payload.question
                  ? [payload.question]
                  : payload.questions === undefined && typeof payload === 'object'
                    ? [payload]
                    : [];
      if (!items.length) return '<div class="preview-block"><p>No valid questions found in JSON.</p></div>';
      const normalized = items.map((item) => normalizeImportedQuestion(item, defaults)).filter(Boolean);
      if (!normalized.length) return '<div class="preview-block"><p>Could not build preview from provided JSON.</p></div>';
      const blocks = normalized.map((question, index) => {
        const displaySubject = question.subject || defaults.subject || '';
        if (question.type === 'cq') {
          const subs = (question.subQuestions || []).map((sub) => `<li><strong>${escapeHtml(sub.label || '')}.</strong> ${formatMathForDisplay(sub.prompt || '', { subject: displaySubject })}<br/><span class="muted-copy">Answer: ${formatExplanationForDisplay(sub.answer || '', { subject: displaySubject })}</span></li>`).join('');
          return `<div class="preview-sub"><strong>Q${index + 1}. ${formatMathForDisplay(question.stimulus || '', { subject: displaySubject })}</strong>${question.image ? `<img class="preview-image" src="${question.image}" alt="CQ" />` : ''}<ul>${subs || '<li>No sub-questions found.</li>'}</ul></div>`;
        }
        const options = (question.options || []).map((option, optionIndex) => {
          const isCorrect = optionIndex === question.correct;
          return `<li>${String.fromCharCode(65 + optionIndex)}. ${formatMathForDisplay(option, { subject: displaySubject })}${isCorrect ? ' <strong>(Correct)</strong>' : ''}</li>`;
        }).join('');
        return `<div class="preview-sub"><strong>Q${index + 1}. ${formatMathForDisplay(question.question || '', { subject: displaySubject })}</strong>${question.image ? `<img class="preview-image" src="${question.image}" alt="MCQ" />` : ''}<ol>${options || '<li>No options found.</li>'}</ol>${question.explanation ? `<p><strong>Explanation:</strong> ${formatExplanationForDisplay(question.explanation, { subject: displaySubject })}</p>` : ''}</div>`;
      }).join('');
      return `<div class="preview-block"><p>JSON Preview (${normalized.length} question${normalized.length > 1 ? 's' : ''})</p>${blocks}</div>`;
    } catch (error) {
      return `<div class="preview-block"><p>Invalid JSON: ${escapeHtml(error?.message || 'Could not parse payload')}</p></div>`;
    }
  }

  function initHandleExamsPage() {
    selectedManageExamId = new URLSearchParams(window.location.search).get('examId') || '';
    bindCurriculumFilterSelectors({ level: 'examFilterLevel', group: 'examFilterGroup', subject: 'examFilterSubject', topic: 'examFilterTopic' });
    bindExamFilters();
    bindPrintConfig();
    renderExamManager();
  }

  function bindCurriculumFilterSelectors(ids) {
    const level = document.getElementById(ids.level);
    const group = document.getElementById(ids.group);
    const subject = document.getElementById(ids.subject);
    const topic = document.getElementById(ids.topic);
    if (!level || !group || !subject || !topic) return;

    const withAll = (items) => ['<option value="">All</option>'].concat(items.map((item) => `<option value="${item}">${item}</option>`)).join('');
    const renderGroups = () => {
      level.innerHTML = withAll(Object.keys(CURRICULUM));
      updateGroups();
    };
    const updateGroups = () => {
      const groups = level.value ? Object.keys(CURRICULUM[level.value] || {}) : [...new Set(Object.values(CURRICULUM).flatMap((item) => Object.keys(item || {})))];
      group.innerHTML = withAll(groups);
      updateSubjects();
    };
    const updateSubjects = () => {
      let subjects = [];
      if (level.value && group.value) subjects = Object.keys(CURRICULUM[level.value]?.[group.value] || {});
      else if (level.value) subjects = [...new Set(Object.values(CURRICULUM[level.value] || {}).flatMap((item) => Object.keys(item || {})))];
      else subjects = [...new Set(Object.values(CURRICULUM).flatMap((lvl) => Object.values(lvl || {}).flatMap((grp) => Object.keys(grp || {}))))];
      subject.innerHTML = withAll(subjects);
      updateTopics();
    };
    const updateTopics = () => {
      let topics = [];
      if (level.value && group.value && subject.value) topics = CURRICULUM[level.value]?.[group.value]?.[subject.value] || [];
      else if (level.value && group.value) topics = [...new Set(Object.values(CURRICULUM[level.value]?.[group.value] || {}).flat())];
      else topics = [...new Set(Object.values(CURRICULUM).flatMap((lvl) => Object.values(lvl || {}).flatMap((grp) => Object.values(grp || {}).flat())))];
      topic.innerHTML = withAll(topics);
    };

    level.addEventListener('change', updateGroups);
    group.addEventListener('change', updateSubjects);
    subject.addEventListener('change', updateTopics);
    renderGroups();
  }

  function bindExamFilters() {
    ['examFilterLevel', 'examFilterGroup', 'examFilterSubject', 'examFilterTopic'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', renderExamManager);
    });
  }

  function bindPrintConfig() {
    const config = state.settings.printConfig;
    ['printHeaderTitle', 'printExamCode', 'printClassLabel', 'printInstructions', 'printDurationLabel', 'printMarksLabel', 'printPaperTitle', 'printPaperSubject', 'printPaperDate', 'printPaperType', 'printHeaderTheme', 'printNumberPrefix', 'printColumns', 'printSetCount', 'printSetLabelStyle'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const key = id.replace('print', '');
      const map = {
        HeaderTitle: 'headerTitle',
        ExamCode: 'examCode',
        ClassLabel: 'classLabel',
        Instructions: 'instructions',
        DurationLabel: 'durationLabel',
        MarksLabel: 'marksLabel',
        PaperTitle: 'paperTitle',
        PaperSubject: 'paperSubject',
        PaperDate: 'paperDate',
        PaperType: 'paperType',
        HeaderTheme: 'headerTheme',
        NumberPrefix: 'numberPrefix',
        Columns: 'columns',
        SetCount: 'setCount',
        SetLabelStyle: 'setLabelStyle',
      };
      el.value = config[map[key]];
      el.addEventListener('input', () => {
        config[map[key]] = map[key] === 'setCount' ? Number(el.value || 1) : el.value;
        saveState();
        renderPrintPreviewMeta();
        renderLivePrintPreview(findExam(selectedManageExamId));
      });
    });
    ['printShowAnswers', 'printShowExplanation', 'printShuffleQuestions', 'printShuffleOptions', 'printAnswerSheet', 'printCompactMode', 'printShowTopicHeading'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const keyMap = {
        printShowAnswers: 'showAnswers',
        printShowExplanation: 'showExplanation',
        printShuffleQuestions: 'shuffleQuestions',
        printShuffleOptions: 'shuffleOptions',
        printAnswerSheet: 'includeAnswerSheet',
        printCompactMode: 'compactMode',
        printShowTopicHeading: 'showTopicHeading',
      };
      const key = keyMap[id];
      el.checked = !!config[key];
      el.addEventListener('change', () => {
        config[key] = el.checked;
        saveState();
        renderPrintPreviewMeta();
        renderLivePrintPreview(findExam(selectedManageExamId));
      });
    });
    const leftLogoInput = document.getElementById('printLeftLogoFile');
    const rightLogoInput = document.getElementById('printRightLogoFile');
    const clearLeftLogoBtn = document.getElementById('clearLeftLogoBtn');
    const clearRightLogoBtn = document.getElementById('clearRightLogoBtn');
    if (leftLogoInput) {
      leftLogoInput.addEventListener('change', async () => {
        const file = leftLogoInput.files?.[0];
        config.leftLogo = file ? await readFileAsDataUrl(file) : '';
        saveState();
        renderPrintPreviewMeta();
        renderLivePrintPreview(findExam(selectedManageExamId));
      });
    }
    if (rightLogoInput) {
      rightLogoInput.addEventListener('change', async () => {
        const file = rightLogoInput.files?.[0];
        config.rightLogo = file ? await readFileAsDataUrl(file) : '';
        saveState();
        renderPrintPreviewMeta();
        renderLivePrintPreview(findExam(selectedManageExamId));
      });
    }
    clearLeftLogoBtn?.addEventListener('click', () => {
      config.leftLogo = '';
      if (leftLogoInput) leftLogoInput.value = '';
      saveState();
      renderPrintPreviewMeta();
      renderLivePrintPreview(findExam(selectedManageExamId));
    });
    clearRightLogoBtn?.addEventListener('click', () => {
      config.rightLogo = '';
      if (rightLogoInput) rightLogoInput.value = '';
      saveState();
      renderPrintPreviewMeta();
      renderLivePrintPreview(findExam(selectedManageExamId));
    });
    renderPrintPreviewMeta();
  }

  function renderPrintPreviewMeta() {
    const preview = document.getElementById('printPreviewMeta');
    if (!preview) return;
    const config = state.settings.printConfig;
    preview.innerHTML = `<div class="preview-block"><h4>${escapeHtml(config.headerTitle)}</h4><p>Code: ${escapeHtml(config.examCode || 'N/A')} · ${escapeHtml(config.classLabel || '')}</p><p>Paper: ${escapeHtml(config.paperTitle || '(Use exam title)')} · ${escapeHtml(config.paperSubject || '(Use exam subject)')}</p><p>Date/Type: ${escapeHtml(config.paperDate || '(Use exam date)')} · ${escapeHtml(config.paperType || '(Use exam type)')}</p><p>Time: ${escapeHtml(config.durationLabel || '')} · Marks: ${escapeHtml(config.marksLabel || '')}</p><p>Theme: ${escapeHtml(config.headerTheme || 'classic')} · Left Logo: ${config.leftLogo ? 'Yes' : 'No'} · Right Logo: ${config.rightLogo ? 'Yes' : 'No'}</p><p>Sets: ${escapeHtml(String(config.setCount || 1))} · Shuffle Q: ${config.shuffleQuestions ? 'Yes' : 'No'} · Shuffle Opt: ${config.shuffleOptions ? 'Yes' : 'No'}</p><p>Answer Sheet: ${config.includeAnswerSheet ? 'On' : 'Off'} · Columns: ${escapeHtml(config.columns)} · Compact: ${config.compactMode ? 'On' : 'Off'} · Topic Heading: ${config.showTopicHeading ? 'On' : 'Off'}</p></div>`;
  }

  function getPaperLabels(version = 'Bangla') {
    const isBangla = String(version || 'Bangla').toLowerCase() === 'bangla';
    return isBangla
      ? {
        qr: 'কিউআর',
        version: 'ভার্সন',
        time: 'সময়',
        subject: 'বিষয়',
        class: 'শ্রেণি',
        fullMarks: 'পূর্ণমান',
        subjectCode: 'বিষয় কোড',
        setCode: 'সেট কোড',
      }
      : {
        qr: 'QR',
        version: 'Version',
        time: 'Time',
        subject: 'Subject',
        class: 'Class',
        fullMarks: 'Full Marks',
        subjectCode: 'Subject Code',
        setCode: 'Set Code',
      };
  }

  function buildPaperHeader({ exam, config, setLabel, setCode = '', includeQr = true, solutionUrl = '' }) {
    const labels = getPaperLabels(exam?.version || 'Bangla');
    const qrPayload = encodeURIComponent(solutionUrl || '');
    const qrCard = includeQr
      ? `<div class="solution-qr solution-qr--header"><img src="https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${qrPayload}" alt="Solution Download QR" /></div>`
      : `<div class="solution-qr solution-qr--header solution-qr--placeholder"><div class="solution-qr__blank"></div></div>`;
    const headerLogos = `${config.leftLogo ? `<img class="header-logo header-logo--left" src="${config.leftLogo}" alt="Left logo" />` : ''}${config.rightLogo ? `<img class="header-logo header-logo--right" src="${config.rightLogo}" alt="Right logo" />` : ''}`;
    const paperSubject = config.paperSubject || exam.subject || 'N/A';
    const timeValue = config.durationLabel || exam.duration || 'N/A';
    const marksValue = config.marksLabel || exam.fullMarks || 'N/A';
    const resolvedSetCode = String(setCode || setLabel || '').replace(/^set\s*/i, '').trim();
    return `<div class="board-head board-head--${escapeAttr(config.headerTheme || 'classic')}">${headerLogos}<div class="board-head-grid"><div class="board-col board-col--left">${qrCard}<div class="board-col__meta"><p><strong>${labels.version}:</strong> ${escapeHtml(exam.version || 'Bangla')}</p><p><strong>${labels.time}:</strong> ${formatMathForDisplay(timeValue)}</p></div></div><div class="board-col board-col--center"><h1>${formatMathForDisplay(config.headerTitle || 'MegaPrep Examination')}</h1><p><strong>${labels.subject}:</strong> ${formatMathForDisplay(paperSubject)}</p><p><strong>${labels.class}:</strong> ${formatMathForDisplay(config.classLabel || 'N/A')}</p><p><strong>${labels.fullMarks}:</strong> ${formatMathForDisplay(marksValue)}</p></div><div class="board-col board-col--right"><div class="board-col__spacer"></div><div class="board-code-box"><p><strong>${labels.subjectCode}:</strong> ${formatMathForDisplay(config.examCode || 'N/A')}</p><p><strong>${labels.setCode}:</strong> ${escapeHtml(resolvedSetCode || 'N/A')}</p></div></div></div><p class="instructions">${formatMathForDisplay(config.instructions)}</p></div>`;
  }

  function renderLivePrintPreview(exam) {
    const panel = document.getElementById('livePrintPreviewPanel');
    if (!panel) return;
    if (!exam) {
      panel.innerHTML = '<p class="muted-copy">Live print preview will appear after selecting an exam.</p>';
      return;
    }
    const sets = buildExamSetVariants(exam);
    if (!sets.length) {
      panel.innerHTML = '<p class="muted-copy">No question mapped yet for this exam.</p>';
      return;
    }
    if (!livePreviewSelectedSet || !sets.some((item) => item.setCode === livePreviewSelectedSet)) livePreviewSelectedSet = sets[0].setCode;
    const activeSet = sets.find((item) => item.setCode === livePreviewSelectedSet) || sets[0];
    const layoutKey = `${exam.id}::${activeSet.setCode}`;
    const layout = livePreviewLayouts.get(layoutKey);
    const renderedQuestions = layout?.questions?.length
      ? layout.questions
      : activeSet.setQuestions.map((question, qIndex) => ({
        id: question.id || `${activeSet.setCode}-q-${qIndex}`,
        question,
        optionsOrder: (question.options || []).map((_, optionIndex) => optionIndex),
      }));
    const answerKey = [];
    renderedQuestions.forEach((entry) => {
      if (entry.question.type !== 'mcq') return;
      const correctSourceIndex = Number(entry.question.correct) || 0;
      const displayIndex = entry.optionsOrder.findIndex((sourceIndex) => sourceIndex === correctSourceIndex);
      const optionIndex = displayIndex >= 0 ? displayIndex : 0;
      answerKey.push(String.fromCharCode(65 + optionIndex));
    });
    let previewMcqNo = 0;
    let previewCqNo = 0;
    const paperQuestions = renderedQuestions.map((entry, index) => {
      const question = entry.question;
      const displaySubject = question.subject || exam.subject || '';
      const serial = question.type === 'mcq' ? String(++previewMcqNo) : `CQ-${++previewCqNo}`;
      const imageBlock = question.image ? `<img class="print-question-image" src="${question.image}" alt="Question visual ${index + 1}" />` : '';
      const options = entry.optionsOrder.map((sourceIndex, localIndex) => `<li draggable="true" data-option-drag="${index}::${sourceIndex}"><span class="option-label">${String.fromCharCode(65 + localIndex)}.</span> <span>${formatMathForDisplay((question.options || [])[sourceIndex] || '', { subject: displaySubject })}</span>${(question.optionImages || [])[sourceIndex] ? `<div><img class="print-option-image" src="${(question.optionImages || [])[sourceIndex]}" alt="Option ${localIndex + 1}" /></div>` : ''}</li>`).join('');
      if (question.type === 'cq') {
        const subs = (question.subQuestions || []).map((item) => `<div><strong>${escapeHtml(item.label || '')}.</strong> ${formatMathForDisplay(item.prompt || '', { subject: displaySubject })}</div>`).join('');
        return `<article class="print-question live-preview-card" draggable="true" data-question-drag="${index}"><div class="live-preview-card__head"><h3>${serial}. ${formatMathForDisplay(question.question || question.stimulus || '', { subject: displaySubject })}</h3><button type="button" class="toolbar-button" data-live-edit="${index}">Edit</button></div>${imageBlock}${subs || '<p class="muted-copy">No sub-question found.</p>'}</article>`;
      }
      return `<article class="print-question live-preview-card" draggable="true" data-question-drag="${index}"><div class="live-preview-card__head"><h3>${serial}. ${formatMathForDisplay(question.question || question.stimulus || '', { subject: displaySubject })}</h3><button type="button" class="toolbar-button" data-live-edit="${index}">Edit</button></div>${imageBlock}<ul class="option-list option-list--grid live-preview-options">${options}</ul></article>`;
    }).join('');
    const headerBlock = buildPaperHeader({
      exam,
      config: activeSet.config,
      setLabel: activeSet.setLabel,
      setCode: activeSet.setCode,
      includeQr: true,
      solutionUrl: getSolutionPublicUrl(exam.id),
    });
    panel.innerHTML = `<h4>Live Print Preview</h4><div class="field-row"><label>Set Filter<select id="livePreviewSetFilter">${sets.map((item) => `<option value="${item.setCode}" ${item.setCode === activeSet.setCode ? 'selected' : ''}>${escapeHtml(item.setLabel)}</option>`).join('')}</select></label></div><p class="muted-copy">Print er moto exact question paper preview. Drag kore question/option position change korle answer key o update hobe.</p><section class="paper set-paper live-preview-paper">${headerBlock}<div class="question-grid">${paperQuestions || '<p>No assigned question found.</p>'}</div></section><div class="table-wrap"><table class="result-table"><thead><tr><th>MCQ No</th><th>Answer Key</th></tr></thead><tbody>${answerKey.map((item, idx) => `<tr><td>${idx + 1}</td><td>${item}</td></tr>`).join('')}</tbody></table></div>`;
    panel.querySelector('#livePreviewSetFilter')?.addEventListener('change', (event) => {
      livePreviewSelectedSet = event.target.value || '';
      renderLivePrintPreview(exam);
    });
    bindLivePreviewDrag(panel, exam, activeSet, renderedQuestions);
    bindLivePreviewEditor(panel, exam, activeSet, renderedQuestions);
    queueTypeset();
  }

  function bindLivePreviewDrag(panel, exam, activeSet, renderedQuestions) {
    const layoutKey = `${exam.id}::${activeSet.setCode}`;
    let questionDragFrom = -1;
    panel.querySelectorAll('[data-question-drag]').forEach((card) => {
      card.addEventListener('dragstart', () => { questionDragFrom = Number(card.dataset.questionDrag); });
      card.addEventListener('dragover', (event) => event.preventDefault());
      card.addEventListener('drop', () => {
        const to = Number(card.dataset.questionDrag);
        if (Number.isNaN(questionDragFrom) || Number.isNaN(to) || questionDragFrom < 0 || to < 0 || questionDragFrom === to) return;
        const next = [...renderedQuestions];
        const [moved] = next.splice(questionDragFrom, 1);
        next.splice(to, 0, moved);
        livePreviewLayouts.set(layoutKey, { questions: next });
        renderLivePrintPreview(exam);
      });
    });
    let optionDragFrom = null;
    panel.querySelectorAll('[data-option-drag]').forEach((item) => {
      item.addEventListener('dragstart', () => {
        const [qIndex, optionIndex] = String(item.dataset.optionDrag || '').split('::').map((value) => Number(value));
        optionDragFrom = { qIndex, optionIndex };
      });
      item.addEventListener('dragover', (event) => event.preventDefault());
      item.addEventListener('drop', () => {
        const [toQIndex, toOptionIndex] = String(item.dataset.optionDrag || '').split('::').map((value) => Number(value));
        if (!optionDragFrom || optionDragFrom.qIndex !== toQIndex || optionDragFrom.optionIndex === toOptionIndex) return;
        const next = [...renderedQuestions];
        const order = [...next[toQIndex].optionsOrder];
        const fromPos = order.indexOf(optionDragFrom.optionIndex);
        const toPos = order.indexOf(toOptionIndex);
        if (fromPos < 0 || toPos < 0) return;
        const [moved] = order.splice(fromPos, 1);
        order.splice(toPos, 0, moved);
        next[toQIndex] = { ...next[toQIndex], optionsOrder: order };
        livePreviewLayouts.set(layoutKey, { questions: next });
        renderLivePrintPreview(exam);
      });
    });
  }

  function bindLivePreviewEditor(panel, exam, activeSet, renderedQuestions) {
    const layoutKey = `${exam.id}::${activeSet.setCode}`;
    panel.querySelectorAll('[data-live-edit]').forEach((button) => button.addEventListener('click', () => {
      const index = Number(button.dataset.liveEdit);
      if (Number.isNaN(index) || !renderedQuestions[index]) return;
      const current = renderedQuestions[index];
      const base = current.question || {};
      const nextQuestion = {
        ...base,
        options: [...(base.options || [])],
        subQuestions: (base.subQuestions || []).map((item) => ({ ...item })),
      };
      const updatedStem = window.prompt('Question / Stimulus edit করুন (LaTeX supported):', String(nextQuestion.question || nextQuestion.stimulus || ''));
      if (updatedStem === null) return;
      if (nextQuestion.type === 'cq') nextQuestion.stimulus = updatedStem.trim();
      else nextQuestion.question = updatedStem.trim();
      if (nextQuestion.type !== 'cq') {
        const optionsText = window.prompt('Options (প্রতি লাইনে ১টি):', (nextQuestion.options || []).join('\n'));
        if (optionsText === null) return;
        const parsedOptions = String(optionsText || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
        if (parsedOptions.length < 2) return showToast('MCQ option কমপক্ষে 2টি লাগবে।', 'error');
        const correctRaw = window.prompt('Correct option (A/B/C/D or text):', String.fromCharCode(65 + (Number(nextQuestion.correct) || 0)));
        if (correctRaw === null) return;
        const explanation = window.prompt('Explanation edit করুন (optional, LaTeX supported):', String(nextQuestion.explanation || ''));
        if (explanation === null) return;
        nextQuestion.options = parsedOptions;
        nextQuestion.correct = normalizeCorrectIndex(null, correctRaw, parsedOptions);
        nextQuestion.explanation = String(explanation || '');
      } else {
        const subPrompt = window.prompt('Sub-question prompt+answer edit করতে চান? (yes/no)', 'no');
        if ((subPrompt || '').toLowerCase() === 'yes') {
          nextQuestion.subQuestions = (nextQuestion.subQuestions || []).map((item, subIndex) => {
            const prompt = window.prompt(`Sub-${subIndex + 1} prompt:`, String(item.prompt || ''));
            if (prompt === null) return item;
            const answer = window.prompt(`Sub-${subIndex + 1} answer:`, String(item.answer || ''));
            if (answer === null) return item;
            return { ...item, prompt: prompt.trim(), answer: answer.trim() };
          });
        }
      }
      nextQuestion.updatedAt = new Date().toISOString();
      const next = [...renderedQuestions];
      next[index] = { ...current, question: nextQuestion };
      livePreviewLayouts.set(layoutKey, { questions: next });
      persistLivePreviewQuestionEdit(exam, nextQuestion);
      saveState();
      renderLivePrintPreview(exam);
      showToast('Live preview question updated.');
    }));
  }

  function persistLivePreviewQuestionEdit(exam, nextQuestion) {
    if (!nextQuestion?.id) return;
    const base = state.questions.find((item) => item.id === nextQuestion.id);
    if (base) {
      Object.assign(base, {
        question: String(nextQuestion.question || ''),
        stimulus: String(nextQuestion.stimulus || ''),
        explanation: String(nextQuestion.explanation || ''),
        options: [...(nextQuestion.options || [])],
        subQuestions: (nextQuestion.subQuestions || []).map((item) => ({ ...item })),
        correct: Number(nextQuestion.correct) || 0,
        updatedAt: nextQuestion.updatedAt || new Date().toISOString(),
      });
    }
    if (exam?.publishedSnapshot?.questions?.length) {
      const snapQuestion = exam.publishedSnapshot.questions.find((item) => item.id === nextQuestion.id);
      if (snapQuestion) {
        Object.assign(snapQuestion, {
          question: String(nextQuestion.question || ''),
          stimulus: String(nextQuestion.stimulus || ''),
          explanation: String(nextQuestion.explanation || ''),
          options: [...(nextQuestion.options || [])],
          subQuestions: (nextQuestion.subQuestions || []).map((item) => ({ ...item })),
          correct: Number(nextQuestion.correct) || 0,
          updatedAt: nextQuestion.updatedAt || new Date().toISOString(),
        });
      }
    }
  }

  function renderExamManager() {
    const target = document.getElementById('examManagerList');
    const filterForm = document.getElementById('questionFilterForm');
    if (!target) return;
    if (!state.exams.length) {
      target.innerHTML = emptyState('No exams available.');
      renderPrintFormatActions(null);
      return;
    }
    const scopedExams = selectedManageExamId ? state.exams.filter((exam) => exam.id === selectedManageExamId) : state.exams;
    if (!scopedExams.length) {
      if (filterForm) filterForm.style.display = '';
      target.innerHTML = `<div class="preview-block"><p>Selected exam was not found.</p><a class="toolbar-button" href="handle-exams.html">Back to exam list</a></div>`;
      return;
    }

    if (!selectedManageExamId) {
      if (filterForm) filterForm.style.display = 'none';
      target.innerHTML = scopedExams.map((exam) => `<article class="entity-card"><div><h4>${escapeHtml(exam.title)}</h4><p>${escapeHtml(exam.level)} · ${escapeHtml(exam.subject)} · ${exam.questionIds.length} Questions</p></div><a class="toolbar-button" href="handle-exams.html?examId=${exam.id}">Manage</a></article>`).join('');
      renderPrintFormatActions(null);
      return;
    }

    if (filterForm) filterForm.style.display = '';
    const filters = getQuestionFilters();
    target.innerHTML = scopedExams.map((exam) => {
      const filteredQuestions = state.questions.filter((question) => {
        if (exam.subject && question.subject && question.subject !== exam.subject) return false;
        if (exam.version && String(question.version || 'Bangla') !== String(exam.version)) return false;
        if (filters.level && question.level !== filters.level) return false;
        if (filters.group && question.group !== filters.group) return false;
        if (filters.subject && question.subject !== filters.subject) return false;
        if (filters.topic && question.topic !== filters.topic) return false;
        return true;
      });
      return `<article class="entity-card entity-card--stacked"><div class="entity-card__head"><div><h4>${escapeHtml(exam.title)}</h4><p>${escapeHtml(exam.level)} · ${escapeHtml(exam.subject)} · ${escapeHtml(exam.version || 'Bangla')} · ${exam.questionIds.length} Questions · ${escapeHtml(String(exam.setCount || state.settings.printConfig.setCount || 1))} Sets</p></div><span class="status-pill ${exam.published ? 'is-live' : ''}">${exam.published ? 'Published' : 'Draft'}</span></div><div class="entity-actions"><a class="toolbar-button" href="handle-exams.html">Back to exam list</a></div><div class="assignment-box"><label>Auto build from Question Bank</label><div class="app-form app-form--two-col"><label>MCQ Count<input type="number" min="0" value="30" data-auto-mcq="${exam.id}" /></label><label>CQ Count<input type="number" min="0" value="0" data-auto-cq="${exam.id}" /></label><label>Mode<select data-auto-mode="${exam.id}"><option value="replace">Replace existing</option><option value="append">Append with existing</option></select></label><label>Version<select data-auto-version="${exam.id}"><option value="Bangla" ${String(exam.version || 'Bangla') === 'Bangla' ? 'selected' : ''}>Bangla Version</option><option value="English" ${String(exam.version || 'Bangla') === 'English' ? 'selected' : ''}>English Version</option></select></label><label>Set Count<input type="number" min="1" max="10" value="${escapeAttr(String(exam.setCount || state.settings.printConfig.setCount || 1))}" data-auto-setcount="${exam.id}" /></label><label class="checkbox-row checkbox-card full-span"><input type="checkbox" data-auto-unique-sets="${exam.id}" ${exam.uniqueSetGeneration ? 'checked' : ''} /><span>Unique set questions (ON = প্রতিটি set এ আলাদা প্রশ্ন, OFF = একই প্রশ্ন shuffle)</span></label><div class="full-span entity-actions"><button type="button" class="toolbar-button" data-auto-apply-setcount="${exam.id}">Save Set Count</button><button type="button" class="submit-button" data-auto-generate="${exam.id}">Auto Generate Questions</button></div><p class="full-span muted-copy">Unique set OFF থাকলে একই question list থেকে সেটভিত্তিক shuffle হবে। Unique set ON করলে প্রতি set এর জন্য আলাদা প্রশ্ন টানা হবে (পর্যাপ্ত প্রশ্ন pool দরকার)।</p></div><label>Assign questions (Manual)</label><div class="assignment-list">${filteredQuestions.length ? filteredQuestions.map((question) => `<div class="assignment-item"><label><input type="checkbox" data-exam-id="${exam.id}" data-question-id="${question.id}" ${exam.questionIds.includes(question.id) ? 'checked' : ''} /><span>${escapeHtml((question.type || 'mcq').toUpperCase())} · ${escapeHtml(question.version || 'Bangla')} · ${escapeHtml(question.topic || question.section || 'Topic')} · ${escapeHtml(question.question || question.stimulus || 'Question')}</span></label><button type="button" class="toolbar-button" data-inline-edit="${question.id}">${activeManageEditQuestionId === question.id ? 'Close Edit' : 'Edit'}</button></div>${activeManageEditQuestionId === question.id ? buildInlineManageQuestionEditor(question) : ''}`).join('') : '<p class="muted-copy">No matching questions found for current filter.</p>'}</div></div></article>`;
    }).join('');
    renderPrintFormatActions(scopedExams[0] || null);
    target.querySelectorAll('[data-publish-exam]').forEach((button) => button.addEventListener('click', () => {
      const exam = findExam(button.dataset.publishExam);
      if (!exam) return showToast('Exam not found.', 'error');
      exam.published = !exam.published;
      if (exam.published) {
        exam.publishedAt = new Date().toISOString();
        exam.publishedSnapshot = {
          config: structuredClone(state.settings.printConfig),
          questions: (exam.questionIds || []).map((id) => state.questions.find((question) => question.id === id)).filter(Boolean).map((question) => ({
            ...question,
            options: [...(question.options || [])],
            subQuestions: (question.subQuestions || []).map((item) => ({ ...item })),
          })),
        };
      } else {
        delete exam.publishedAt;
        delete exam.publishedSnapshot;
      }
      saveState();
      renderExamManager();
    }));
    target.querySelectorAll('input[data-exam-id]').forEach((checkbox) => checkbox.addEventListener('change', () => {
      const exam = findExam(checkbox.dataset.examId);
      if (!exam) return showToast('Exam not found.', 'error');
      exam.questionIds = checkbox.checked ? [...new Set([...exam.questionIds, checkbox.dataset.questionId])] : exam.questionIds.filter((id) => id !== checkbox.dataset.questionId);
      exam.uniqueSetGeneration = false;
      exam.setQuestionMap = {};
      saveState();
      renderExamManager();
      showToast('Exam question mapping updated.');
    }));
    target.querySelectorAll('[data-auto-apply-setcount]').forEach((button) => button.addEventListener('click', () => {
      const exam = findExam(button.dataset.autoApplySetcount);
      if (!exam) return showToast('Exam not found.', 'error');
      const input = target.querySelector(`[data-auto-setcount="${exam.id}"]`);
      exam.setCount = Math.max(1, Math.min(10, Number(input?.value || 1)));
      saveState();
      renderExamManager();
      showToast('Set count saved for this exam.');
    }));
    target.querySelectorAll('[data-auto-generate]').forEach((button) => button.addEventListener('click', () => {
      const exam = findExam(button.dataset.autoGenerate);
      if (!exam) return showToast('Exam not found.', 'error');
      const mcqCount = Number(target.querySelector(`[data-auto-mcq="${exam.id}"]`)?.value || 0);
      const cqCount = Number(target.querySelector(`[data-auto-cq="${exam.id}"]`)?.value || 0);
      const mode = String(target.querySelector(`[data-auto-mode="${exam.id}"]`)?.value || 'replace');
      const version = String(target.querySelector(`[data-auto-version="${exam.id}"]`)?.value || exam.version || 'Bangla');
      const uniqueSets = !!target.querySelector(`[data-auto-unique-sets="${exam.id}"]`)?.checked;
      const filtersNow = getQuestionFilters();
      autoAssignQuestionsToExam(exam, { mcqCount, cqCount, mode, version, filters: filtersNow, uniqueSets });
      saveState();
      renderExamManager();
    }));
    target.querySelectorAll('[data-inline-edit]').forEach((button) => button.addEventListener('click', () => {
      activeManageEditQuestionId = activeManageEditQuestionId === button.dataset.inlineEdit ? '' : button.dataset.inlineEdit;
      renderExamManager();
    }));
    target.querySelectorAll('[data-inline-cancel]').forEach((button) => button.addEventListener('click', () => {
      activeManageEditQuestionId = '';
      renderExamManager();
    }));
    target.querySelectorAll('[data-inline-save]').forEach((button) => button.addEventListener('click', () => saveInlineManageQuestion(button.dataset.inlineSave)));
    target.querySelectorAll('[data-inline-remove-sub]').forEach((button) => button.addEventListener('click', () => {
      button.closest('.inline-sub-row')?.remove();
    }));
    target.querySelectorAll('[data-inline-clear-sub-label]').forEach((button) => button.addEventListener('click', () => {
      const input = button.closest('.inline-sub-row')?.querySelector('[data-inline-sub-label]');
      if (input) input.value = '';
    }));
  }

  function autoAssignQuestionsToExam(exam, options = {}) {
    const mcqCount = Math.max(0, Number(options.mcqCount || 0));
    const cqCount = Math.max(0, Number(options.cqCount || 0));
    const mode = String(options.mode || 'replace');
    const version = String(options.version || exam.version || 'Bangla');
    const uniqueSets = !!options.uniqueSets;
    const filters = options.filters || {};
    const safeSetCount = Math.max(1, Math.min(10, Number(exam.setCount || state.settings.printConfig.setCount || 1)));
    const labelStyle = String(state.settings.printConfig?.setLabelStyle || 'alphabet');

    const pool = state.questions.filter((question) => {
      if (exam.subject && question.subject && question.subject !== exam.subject) return false;
      if (filters.level && question.level !== filters.level) return false;
      if (filters.group && question.group !== filters.group) return false;
      if (filters.subject && question.subject !== filters.subject) return false;
      if (filters.topic && question.topic !== filters.topic) return false;
      if (version && String(question.version || 'Bangla') !== version) return false;
      return true;
    });

    const mcqPool = shuffleArray(pool.filter((q) => String(q.type || 'mcq').toLowerCase() !== 'cq'));
    const cqPool = shuffleArray(pool.filter((q) => String(q.type || 'mcq').toLowerCase() === 'cq'));
    if (uniqueSets) {
      const needMcq = mcqCount * safeSetCount;
      const needCq = cqCount * safeSetCount;
      if (mcqPool.length < needMcq || cqPool.length < needCq) {
        return showToast(`Unique set generation failed: need ${needMcq} MCQ & ${needCq} CQ, পাওয়া গেছে ${mcqPool.length} MCQ & ${cqPool.length} CQ.`, 'error');
      }
      const setQuestionMap = {};
      const combined = [];
      for (let setIndex = 0; setIndex < safeSetCount; setIndex += 1) {
        const setCode = getSetCodeByIndex(setIndex, labelStyle);
        const fromMcq = mcqPool.slice(setIndex * mcqCount, (setIndex + 1) * mcqCount);
        const fromCq = cqPool.slice(setIndex * cqCount, (setIndex + 1) * cqCount);
        const setQuestions = shuffleArray([...fromMcq, ...fromCq]);
        const ids = setQuestions.map((item) => item.id);
        setQuestionMap[setCode] = ids;
        combined.push(...ids);
      }
      exam.questionIds = mode === 'append' ? [...new Set([...(exam.questionIds || []), ...combined])] : [...new Set(combined)];
      exam.uniqueSetGeneration = true;
      exam.setQuestionMap = setQuestionMap;
      exam.version = version;
      return showToast(`Unique set ready: ${safeSetCount} সেটে আলাদা প্রশ্ন বসানো হয়েছে।`);
    }

    const selectedIds = [...mcqPool.slice(0, mcqCount), ...cqPool.slice(0, cqCount)].map((q) => q.id);
    if (!selectedIds.length) return showToast('Filter অনুযায়ী কোন প্রশ্ন পাওয়া যায়নি।', 'error');
    exam.questionIds = mode === 'append' ? [...new Set([...(exam.questionIds || []), ...selectedIds])] : [...new Set(selectedIds)];
    exam.uniqueSetGeneration = false;
    exam.setQuestionMap = {};
    exam.version = version;
    showToast(`Auto assigned: ${selectedIds.length} প্রশ্ন (${Math.min(mcqCount, mcqPool.length)} MCQ, ${Math.min(cqCount, cqPool.length)} CQ).`);
  }

  function getSetCodeByIndex(setIndex, labelStyle = 'alphabet') {
    return labelStyle === 'numeric' ? String(setIndex + 1) : String.fromCharCode(65 + setIndex);
  }

  function buildInlineManageQuestionEditor(question) {
    if (!question) return '';
    if (question.type === 'cq') {
      const subs = (question.subQuestions?.length ? question.subQuestions : [{ label: 'A', prompt: '', answer: '' }])
        .map((item, index) => `<div class="inline-sub-row"><label>Label<input data-inline-sub-label type="text" value="${escapeAttr(item.label || '')}" /></label><label>Prompt<textarea data-inline-sub-prompt rows="2">${escapeHtml(item.prompt || '')}</textarea></label><label>Answer<textarea data-inline-sub-answer rows="2">${escapeHtml(item.answer || '')}</textarea></label><button type="button" class="toolbar-button" data-inline-clear-sub-label="1">Clear Label</button><button type="button" class="toolbar-button" data-inline-remove-sub="1">Remove</button></div>`).join('');
      return `<div class="preview-surface preview-surface--small"><h4>Inline Edit · CQ</h4><label>Stimulus<textarea data-inline-stimulus="${question.id}" rows="4">${escapeHtml(question.stimulus || '')}</textarea></label><label>Section<input data-inline-section="${question.id}" type="text" value="${escapeAttr(question.section || '')}" /></label><div class="assignment-list">${subs}</div><div class="entity-actions"><button type="button" class="toolbar-button" data-inline-save="${question.id}">Save</button><button type="button" class="toolbar-button" data-inline-cancel="${question.id}">Cancel</button></div></div>`;
    }
    const correctLetter = String.fromCharCode(65 + (Number(question.correct) || 0));
    const options = (question.options || []).map((option, index) => `<label>Option ${String.fromCharCode(65 + index)}<input data-inline-option="${question.id}" type="text" value="${escapeAttr(option || '')}" /></label>`).join('');
    return `<div class="preview-surface preview-surface--small"><h4>Inline Edit · MCQ</h4><label>Question<textarea data-inline-question="${question.id}" rows="4">${escapeHtml(question.question || '')}</textarea></label><label>Explanation<textarea data-inline-explanation="${question.id}" rows="4">${escapeHtml(question.explanation || '')}</textarea></label><label>Section<input data-inline-section="${question.id}" type="text" value="${escapeAttr(question.section || '')}" /></label><div class="field-row">${options}</div><label>Correct Option (A/B/C/D)<input data-inline-correct="${question.id}" type="text" value="${escapeAttr(correctLetter)}" /></label><div class="entity-actions"><button type="button" class="toolbar-button" data-inline-save="${question.id}">Save</button><button type="button" class="toolbar-button" data-inline-cancel="${question.id}">Cancel</button></div></div>`;
  }

  function saveInlineManageQuestion(questionId) {
    const question = state.questions.find((item) => item.id === questionId);
    if (!question) return showToast('Question not found.', 'error');
    try {
      if (question.type === 'cq') {
        const stimulus = document.querySelector(`[data-inline-stimulus="${questionId}"]`)?.value?.trim() || '';
        const section = document.querySelector(`[data-inline-section="${questionId}"]`)?.value?.trim() || '';
        const parsedSubs = [...document.querySelectorAll('.inline-sub-row')].map((row) => ({
          label: row.querySelector('[data-inline-sub-label]')?.value?.trim() || '',
          prompt: row.querySelector('[data-inline-sub-prompt]')?.value?.trim() || '',
          answer: row.querySelector('[data-inline-sub-answer]')?.value?.trim() || '',
        }));
        question.stimulus = stimulus;
        question.section = section;
        question.subQuestions = parsedSubs
          .map((item, index) => ({
            label: String(item?.label || '').trim(),
            prompt: String(item?.prompt || '').trim(),
            answer: String(item?.answer || '').trim(),
            order: index,
          }))
          .filter((item) => item.prompt || item.answer || item.label);
      } else {
        const text = document.querySelector(`[data-inline-question="${questionId}"]`)?.value?.trim() || '';
        const explanation = document.querySelector(`[data-inline-explanation="${questionId}"]`)?.value || '';
        const section = document.querySelector(`[data-inline-section="${questionId}"]`)?.value?.trim() || '';
        const correctRaw = document.querySelector(`[data-inline-correct="${questionId}"]`)?.value?.trim() || '';
        const options = [...document.querySelectorAll(`[data-inline-option="${questionId}"]`)].map((input) => String(input.value || '').trim()).filter(Boolean);
        if (!text || !options.length) throw new Error('Question text and options are required.');
        question.question = text;
        question.explanation = explanation;
        question.section = section;
        question.options = options;
        question.correct = normalizeCorrectIndex(null, correctRaw, options);
      }
      question.updatedAt = new Date().toISOString();
      saveState();
      activeManageEditQuestionId = '';
      renderExamManager();
      showToast('Question updated from Manage Exam.');
    } catch (error) {
      showToast(error?.message || 'Failed to save inline edit.', 'error');
    }
  }

  function renderPrintFormatActions(exam) {
    const holder = document.getElementById('printFormatActions');
    if (!holder) return;
    if (!exam) {
      holder.innerHTML = '<p class="muted-copy">Select an exam to use Edit/Publish/Download/Print actions.</p>';
      renderLivePrintPreview(null);
      return;
    }
    renderLivePrintPreview(exam);
    holder.innerHTML = `<a class="toolbar-button" href="create-exam.html?examId=${exam.id}">Edit</a><button type="button" class="toolbar-button ${exam.published ? 'toolbar-button--success' : ''}" data-sidebar-publish="${exam.id}">${exam.published ? 'Published' : 'Publish'}</button><button type="button" class="toolbar-button ${exam.solutionPublished ? 'toolbar-button--success' : ''}" data-sidebar-solution-publish="${exam.id}">${exam.solutionPublished ? 'Solution Published' : 'Solution Publish'}</button><button type="button" class="toolbar-button" data-sidebar-download="${exam.id}">Download</button><button type="button" class="toolbar-button" data-sidebar-print="${exam.id}">Print</button><button type="button" class="toolbar-button" data-sidebar-solution-download="${exam.id}">Solution Download</button><button type="button" class="toolbar-button" data-sidebar-question-docs="${exam.id}">Question Paper Docs</button><button type="button" class="toolbar-button" data-sidebar-solution-docs="${exam.id}">Solution Paper Docs</button><button type="button" class="toolbar-button" data-sidebar-print-omr="${exam.id}">Print OMR</button><a class="toolbar-button" href="result-analyse.html?examId=${exam.id}">Result Analyse</a><button type="button" class="toolbar-button toolbar-button--danger" data-sidebar-delete="${exam.id}">Delete</button>`;

    const refreshPublishUi = (item) => {
      const publishBtn = holder.querySelector('[data-sidebar-publish]');
      if (publishBtn) {
        publishBtn.textContent = item.published ? 'Published' : 'Publish';
        publishBtn.classList.toggle('toolbar-button--success', !!item.published);
      }
      const solutionPublishBtn = holder.querySelector('[data-sidebar-solution-publish]');
      if (solutionPublishBtn) {
        solutionPublishBtn.textContent = item.solutionPublished ? 'Solution Published' : 'Solution Publish';
        solutionPublishBtn.classList.toggle('toolbar-button--success', !!item.solutionPublished);
      }
      const statusPill = document.querySelector('#examManagerList .status-pill');
      if (statusPill) {
        statusPill.textContent = item.published ? 'Published' : 'Draft';
        statusPill.classList.toggle('is-live', !!item.published);
      }
    };
    holder.querySelector('[data-sidebar-publish]')?.addEventListener('click', (event) => {
      event.preventDefault();
      const examId = event.currentTarget?.dataset?.sidebarPublish || exam.id;
      const item = findExam(examId);
      if (!item) return showToast('Exam not found.', 'error');
      item.published = !item.published;
      if (item.published) {
        item.publishedAt = new Date().toISOString();
        item.publishedSnapshot = { config: structuredClone(state.settings.printConfig), questions: [] };
      } else {
        delete item.publishedAt;
        delete item.publishedSnapshot;
      }
      refreshPublishUi(item);
      saveState();
      if (item.published) {
        const publishedExamId = item.id;
        setTimeout(() => {
          const liveExam = findExam(publishedExamId);
          if (!liveExam || !liveExam.published) return;
          liveExam.publishedSnapshot = buildPublishedSnapshot(liveExam);
          saveState();
        }, 0);
      }
      showToast(item.published ? 'Exam published.' : 'Exam unpublished.');
    });
    holder.querySelector('[data-sidebar-delete]')?.addEventListener('click', () => {
      state.exams = state.exams.filter((item) => item.id !== exam.id);
      state.attempts = state.attempts.filter((attempt) => attempt.examId !== exam.id);
      saveState();
      if (selectedManageExamId === exam.id) window.location.href = 'handle-exams.html';
      else renderExamManager();
      showToast('Exam deleted.');
    });
    holder.querySelector('[data-sidebar-download]')?.addEventListener('click', () => downloadExamPaper(exam.id));
    holder.querySelector('[data-sidebar-print]')?.addEventListener('click', () => printExamPaper(exam.id));
    holder.querySelector('[data-sidebar-solution-download]')?.addEventListener('click', () => {
      window.open(getSolutionPublicUrl(exam.id), '_blank', 'noopener,noreferrer');
    });
    holder.querySelector('[data-sidebar-question-docs]')?.addEventListener('click', () => downloadExamPaperDocs(exam.id));
    holder.querySelector('[data-sidebar-solution-docs]')?.addEventListener('click', () => downloadSolutionPaperDocs(exam.id));
    holder.querySelector('[data-sidebar-print-omr]')?.addEventListener('click', () => printOmrSheet(exam.id));
    holder.querySelector('[data-sidebar-solution-publish]')?.addEventListener('click', async (event) => {
      event.preventDefault();
      const examId = event.currentTarget?.dataset?.sidebarSolutionPublish || exam.id;
      const item = findExam(examId);
      if (!item) return showToast('Exam not found.', 'error');
      item.solutionPublished = !item.solutionPublished;
      if (item.solutionPublished) item.solutionPublishedAt = new Date().toISOString();
      else delete item.solutionPublishedAt;
      refreshPublishUi(item);
      saveState();
      try {
        if (item.solutionPublished) await publishSolutionSnapshot(item);
        else await unpublishSolutionSnapshot(item.id);
        showToast(item.solutionPublished ? 'Solution link published.' : 'Solution link unpublished.');
      } catch (error) {
        showToast(error?.message || 'Solution publish sync failed.', 'error');
      }
    });
  }

  function renderResultAnalyzer(exam) {
    const panel = document.getElementById('resultAnalyzerPanel');
    if (!panel) return;
    panel.hidden = false;
    panel.innerHTML = `<h4>Result Analyse · ${escapeHtml(exam.title)}</h4><p class="muted-copy">Student list XLSX columns: <code>roll_number, student_name, class, phone_number</code>. তারপর একসাথে OMR image upload করে batch result process করুন।</p><label class="toolbar-button toolbar-button--file">Upload Student List XLSX<input id="studentListXlsxFile" type="file" accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" hidden /></label><label class="toolbar-button toolbar-button--file">Upload Filled OMR Images<input id="omrImageBatchFile" type="file" accept="image/*" multiple hidden /></label><div class="entity-actions"><button id="processOmrImageBatchBtn" type="button" class="submit-button">Process OMR Images</button><button id="exportResultXlsxBtn" type="button" class="toolbar-button">Export Result XLSX</button></div><div id="resultBatchOutput"></div>`;
    panel.querySelector('#processOmrImageBatchBtn')?.addEventListener('click', () => processOmrImageBatch(exam.id));
    panel.querySelector('#exportResultXlsxBtn')?.addEventListener('click', exportLatestResultWorkbook);
  }

  async function processOmrImageBatch(examId) {
    const panel = document.getElementById('resultAnalyzerPanel');
    if (!panel) return;
    const studentFile = panel.querySelector('#studentListXlsxFile')?.files?.[0];
    const imageFiles = [...(panel.querySelector('#omrImageBatchFile')?.files || [])];
    const output = panel.querySelector('#resultBatchOutput');
    if (!studentFile || !imageFiles.length) {
      if (output) output.innerHTML = '<p class="muted-copy">Student XLSX এবং OMR image batch দুটোই upload করুন।</p>';
      return;
    }
    if (output) output.innerHTML = '<p class="muted-copy">Processing OMR images... please wait.</p>';
    const students = await readStudentListFromXlsx(studentFile);
    let exam = findExam(examId);
    if (!exam || !exam.solutionPublished) {
      target.innerHTML = '<p class="muted-copy">Loading published solution...</p>';
      try {
        const published = await fetchPublishedSolution(examId);
        if (published) exam = installPublishedSolutionPayload(published);
      } catch (error) {
        console.warn('Published solution fetch failed:', error?.message || error);
      }
    }
    if (!exam) {
      if (output) output.innerHTML = '<p class="muted-copy">Exam not found.</p>';
      return;
    }
    const setVariants = buildExamSetVariants(exam);
    const defaultKey = setVariants[0]?.answerKey || [];
    const detected = [];
    const cv = await tryLoadOpenCv((done, total, fileName) => {
      if (output) output.innerHTML = renderOmrProgress(done, total, fileName);
    }, imageFiles.length);
    for (let fileIndex = 0; fileIndex < imageFiles.length; fileIndex += 1) {
      const file = imageFiles[fileIndex];
      if (output) output.innerHTML = renderOmrProgress(fileIndex, imageFiles.length, file.name);
      await yieldToBrowser();
      let omr = buildEmptyOmrDetection(defaultKey.filter((key) => key !== 'CQ').length, 'fallback');
      try {
        omr = cv
          ? await detectOmrFromImage(file, defaultKey.filter((key) => key !== 'CQ').length, cv)
          : await detectOmrFromImageCanvas(file, defaultKey.filter((key) => key !== 'CQ').length);
      } catch (error) {
        console.warn('Frontend OMR processing failed:', error?.message || error);
      }
      const answerKey = deriveStaticAnswerKey(exam, omr.setCode);
      const student = students.get(omr.roll) || {};
      const result = evaluateDetectedAnswers(answerKey, omr.answers);
      detected.push({
        roll: omr.roll || '',
        student_name: student.student_name || '',
        class: student.class || '',
        phone_number: student.phone_number || '',
        correct: result.correct,
        wrong: result.wrong,
        not_answered: result.notAnswered,
        total: result.total,
        score: result.correct,
        percent: result.total ? ((result.correct / result.total) * 100).toFixed(2) : '0.00',
      });
      if (output) output.innerHTML = renderOmrProgress(fileIndex + 1, imageFiles.length, file.name);
      await yieldToBrowser();
    }
    detected.sort((a, b) => (b.score - a.score) || (a.wrong - b.wrong) || a.roll.localeCompare(b.roll));
    detected.forEach((row, index) => { row.merit_position = index + 1; });
    window.__latestOmrBatchResult = detected;
    if (!output) return;
    output.innerHTML = detected.length
      ? `<div class="table-wrap"><table><thead><tr><th>Merit</th><th>Roll</th><th>Name</th><th>Class</th><th>Phone</th><th>Correct</th><th>Wrong</th><th>Not Answered</th><th>Total</th><th>Percent</th></tr></thead><tbody>${detected.map((item) => `<tr><td>${item.merit_position}</td><td>${escapeHtml(item.roll)}</td><td>${escapeHtml(item.student_name)}</td><td>${escapeHtml(item.class)}</td><td>${escapeHtml(item.phone_number)}</td><td>${item.correct}</td><td>${item.wrong}</td><td>${item.not_answered}</td><td>${item.total}</td><td>${item.percent}%</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted-copy">No valid OMR detected.</p>';
  }

  function deriveStaticAnswerKey(exam, setCode = '') {
    if (!exam) return [];
    const variants = buildExamSetVariants(exam);
    if (!variants.length) return [];
    const selected = variants.find((item) => !setCode || String(item.setCode).toUpperCase() === String(setCode).toUpperCase()) || variants[0];
    return selected.answerKey;
  }

  function buildExamSetVariants(exam) {
    if (!exam) return [];
    const snapshot = exam.published && exam.publishedSnapshot ? exam.publishedSnapshot : null;
    const config = snapshot?.config ? mergePrintConfig(snapshot.config) : state.settings.printConfig;
    const questions = snapshot?.questions
      ? snapshot.questions.map((question) => ({ ...question, options: [...(question.options || [])], subQuestions: (question.subQuestions || []).map((item) => ({ ...item })) }))
      : (exam.questionIds || []).map((id) => state.questions.find((question) => question.id === id)).filter(Boolean);
    const scopedQuestions = questions.filter((question) => !exam.version || String(question.version || 'Bangla') === String(exam.version));
    const safeSetCount = Math.max(1, Math.min(10, Number(exam.setCount || config.setCount || 1)));
    return Array.from({ length: safeSetCount }, (_, setIndex) => {
      const setCode = getSetCodeByIndex(setIndex, config.setLabelStyle);
      const setLabel = config.setLabelStyle === 'numeric' ? `Set ${setIndex + 1}` : `Set ${setCode}`;
      const setSpecificIds = exam.uniqueSetGeneration ? (exam.setQuestionMap?.[setCode] || []) : [];
      const setSpecificQuestions = setSpecificIds
        .map((id) => questions.find((item) => item.id === id))
        .filter(Boolean);
      const source = setSpecificQuestions.length ? setSpecificQuestions : scopedQuestions;
      const generated = buildQuestionSet(source, config, { seed: `${exam.id}-${setCode}` });
      const { setQuestions, answerKey } = applyLiveLayoutToSet(exam.id, setCode, generated.setQuestions);
      return { setIndex, setCode, setLabel, setQuestions, answerKey, config };
    });
  }

  function applyLiveLayoutToSet(examId, setCode, setQuestions) {
    const layout = livePreviewLayouts.get(`${examId}::${setCode}`);
    if (!layout?.questions?.length) return { setQuestions, answerKey: deriveAnswerKeyFromQuestions(setQuestions) };
    const normalized = layout.questions.map((entry) => {
      const baseOptions = entry.question?.options || [];
      const optionsOrder = entry.optionsOrder?.length ? entry.optionsOrder : baseOptions.map((_, idx) => idx);
      const orderedOptions = optionsOrder.map((sourceIndex) => baseOptions[sourceIndex]).filter((item) => typeof item !== 'undefined');
      const originalCorrect = Number(entry.question?.correct) || 0;
      const nextCorrect = optionsOrder.indexOf(originalCorrect);
      return {
        ...entry.question,
        options: orderedOptions.length ? orderedOptions : baseOptions,
        correct: nextCorrect >= 0 ? nextCorrect : originalCorrect,
      };
    });
    return { setQuestions: normalized, answerKey: deriveAnswerKeyFromQuestions(normalized) };
  }

  function deriveAnswerKeyFromQuestions(questions = []) {
    return questions.map((question) => {
      if (question.type !== 'mcq') return 'CQ';
      return String.fromCharCode(65 + (Number(question.correct) || 0));
    });
  }

  async function readStudentListFromXlsx(file) {
    const XLSX = await ensureXlsxLib();
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    const map = new Map();
    rows.forEach((row) => {
      const roll = String(row.roll_number || row.roll || row.Roll || '').trim();
      if (!roll) return;
      map.set(roll, {
        student_name: String(row.student_name || row.name || row.StudentName || '').trim(),
        class: String(row.class || row.Class || '').trim(),
        institute: String(row.institute || row.Institute || '').trim(),
        phone_number: String(row.phone_number || row.phone || row.Phone || '').trim(),
      });
    });
    return map;
  }

  async function ensureXlsxLib() {
    if (window.XLSX) return window.XLSX;
    await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
    return window.XLSX;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) {
        const existing = document.querySelector(`script[src="${src}"]`);
        if (existing.dataset.loaded === 'true') return resolve();
      }
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => { script.dataset.loaded = 'true'; resolve(); };
      script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
      document.head.appendChild(script);
    });
  }

  function yieldToBrowser() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function ensureOpenCv() {
    if (window.cv?.Mat) return window.cv;
    if (openCvPromise) return openCvPromise;
    openCvPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('OpenCV.js did not load in time.')), 12000);
      const finish = () => {
        clearTimeout(timeout);
        if (window.cv?.Mat) resolve(window.cv);
        else reject(new Error('OpenCV.js loaded but runtime is not ready.'));
      };
      if (window.cv?.Mat) return finish();
      const existing = document.querySelector('script[data-opencv-js="true"]');
      if (existing) {
        const waitTimer = setInterval(() => {
          if (window.cv?.Mat) {
            clearInterval(waitTimer);
            finish();
          }
        }, 100);
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release/opencv.js';
      script.async = true;
      script.dataset.opencvJs = 'true';
      script.onload = () => {
        if (window.cv?.Mat) finish();
        else if (window.cv) window.cv.onRuntimeInitialized = finish;
      };
      script.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Failed to load OpenCV.js.'));
      };
      document.head.appendChild(script);
    }).catch((error) => {
      openCvPromise = null;
      throw error;
    });
    return openCvPromise;
  }

  async function tryLoadOpenCv(onProgress, total) {
    if (onProgress) onProgress(0, total, 'Loading OpenCV.js...');
    try {
      return await Promise.race([
        ensureOpenCv(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('OpenCV is taking too long; using browser fallback.')), 6000)),
      ]);
    } catch (error) {
      console.warn('OpenCV unavailable, using canvas detector:', error?.message || error);
      return null;
    }
  }

  const OMR_TEMPLATE = {
    version: 'mpqm-opencv-v2',
    width: 2480,
    height: 3508,
    anchors: {
      tl: { x: 78, y: 78 },
      tr: { x: 2402, y: 78 },
      bl: { x: 78, y: 3430 },
      br: { x: 2402, y: 3430 },
    },
    roll: { startX: 1748, startY: 1046, columns: 6, rowGap: 31, colGap: 42 },
    registration: { startX: 1748, startY: 1510, columns: 8, rowGap: 31, colGap: 32 },
    set: { startX: 1798, startY: 2180, gap: 105 },
    answers: { startX: 392, startY: 1138, colGap: 332, rowGap: 30, optionGap: 36, rowsPerColumn: 25, columns: 4 },
  };

  function buildEmptyOmrDetection(questionCount, reason = '') {
    return {
      roll: '',
      answers: Array.from({ length: questionCount }, () => ''),
      setCode: '',
      templateVersion: OMR_TEMPLATE.version,
      processedIn: reason || 'fallback',
    };
  }

  async function detectOmrFromImageCanvas(file, questionCount) {
    const imageBitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = OMR_TEMPLATE.width;
    canvas.height = OMR_TEMPLATE.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(imageBitmap, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    if (imageBitmap.close) imageBitmap.close();

    const bubbleScore = (cx, cy, innerRadius = 10, outerRadius = 17) => {
      let innerDark = 0;
      let innerCount = 0;
      let ringDark = 0;
      let ringCount = 0;
      for (let dy = -outerRadius; dy <= outerRadius; dy += 1) {
        for (let dx = -outerRadius; dx <= outerRadius; dx += 1) {
          const dist2 = dx * dx + dy * dy;
          if (dist2 > outerRadius * outerRadius) continue;
          const px = Math.round(cx + dx);
          const py = Math.round(cy + dy);
          if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
          const offset = (py * canvas.width + px) * 4;
          const gray = (data[offset] + data[offset + 1] + data[offset + 2]) / 3;
          const dark = 255 - gray;
          if (dist2 <= innerRadius * innerRadius) {
            innerDark += dark;
            innerCount += 1;
          } else {
            ringDark += dark;
            ringCount += 1;
          }
        }
      }
      const innerAvg = innerCount ? innerDark / innerCount : 0;
      const ringAvg = ringCount ? ringDark / ringCount : 0;
      return (innerAvg / 255) - ((ringAvg / 255) * 0.35);
    };

    const pickOne = (items, threshold = 0.11, marginThreshold = 0.025) => {
      const ranked = items.sort((a, b) => b.score - a.score);
      const best = ranked[0] || { value: '', score: 0 };
      const second = ranked[1] || { score: 0 };
      return best.score >= threshold && best.score - second.score >= marginThreshold ? best.value : '';
    };

    const detectDigits = ({ startX, startY, columns, rowGap, colGap }) => {
      return Array.from({ length: columns }, (_, col) => {
        const x = startX + col * colGap;
        return pickOne(Array.from({ length: 10 }, (_, digit) => ({
          value: String(digit),
          score: bubbleScore(x, startY + digit * rowGap, 8, 14),
        })), 0.1, 0.02);
      }).join('');
    };

    const labels = ['A', 'B', 'C', 'D'];
    const setCode = pickOne(labels.map((label, idx) => ({
      value: label,
      score: bubbleScore(OMR_TEMPLATE.set.startX + idx * OMR_TEMPLATE.set.gap, OMR_TEMPLATE.set.startY, 12, 20),
    })), 0.1, 0.02);

    const answers = [];
    const spec = OMR_TEMPLATE.answers;
    for (let col = 0; col < spec.columns; col += 1) {
      for (let row = 0; row < spec.rowsPerColumn; row += 1) {
        const idx = col * spec.rowsPerColumn + row;
        if (idx >= questionCount) break;
        const x = spec.startX + col * spec.colGap;
        const y = spec.startY + row * spec.rowGap;
        answers.push(pickOne(labels.map((label, optionIndex) => ({
          value: label,
          score: bubbleScore(x + optionIndex * spec.optionGap, y, 8, 14),
        })), 0.1, 0.025));
      }
    }

    return {
      roll: detectDigits(OMR_TEMPLATE.roll),
      answers,
      setCode,
      templateVersion: OMR_TEMPLATE.version,
      processedIn: 'browser-canvas-fallback',
    };
  }

  async function detectOmrFromImage(file, questionCount, cvInstance = null) {
    const cv = cvInstance || await ensureOpenCv();
    const imageBitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = OMR_TEMPLATE.width;
    canvas.height = OMR_TEMPLATE.height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(imageBitmap, 0, 0, canvas.width, canvas.height);
    const src = cv.imread(canvas);
    const gray = new cv.Mat();
    const binary = new cv.Mat();
    const warped = new cv.Mat();
    const warpedBinary = new cv.Mat();
    let srcTri = null;
    let dstTri = null;
    let working = null;

    const findAnchor = (mat, region) => {
      const roiRect = new cv.Rect(region.x, region.y, region.w, region.h);
      const roi = mat.roi(roiRect);
      const contours = new cv.MatVector();
      const hierarchy = new cv.Mat();
      let best = null;
      try {
        cv.findContours(roi, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        for (let i = 0; i < contours.size(); i += 1) {
          const contour = contours.get(i);
          const rect = cv.boundingRect(contour);
          const area = cv.contourArea(contour);
          const ratio = rect.width / Math.max(1, rect.height);
          contour.delete();
          if (area < 1600 || area > 40000 || ratio < 0.65 || ratio > 1.45) continue;
          const score = area - Math.abs(rect.width - rect.height) * 40;
          if (!best || score > best.score) {
            best = { x: region.x + rect.x + rect.width / 2, y: region.y + rect.y + rect.height / 2, score };
          }
        }
        return best;
      } finally {
        roi.delete();
        contours.delete();
        hierarchy.delete();
      }
    };

    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0);
      cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

      const margin = 520;
      const anchors = {
        tl: findAnchor(binary, { x: 0, y: 0, w: margin, h: margin }),
        tr: findAnchor(binary, { x: OMR_TEMPLATE.width - margin, y: 0, w: margin, h: margin }),
        bl: findAnchor(binary, { x: 0, y: OMR_TEMPLATE.height - margin, w: margin, h: margin }),
        br: findAnchor(binary, { x: OMR_TEMPLATE.width - margin, y: OMR_TEMPLATE.height - margin, w: margin, h: margin }),
      };
      const hasAnchors = anchors.tl && anchors.tr && anchors.bl && anchors.br;
      if (hasAnchors) {
        srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
          anchors.tl.x, anchors.tl.y,
          anchors.tr.x, anchors.tr.y,
          anchors.br.x, anchors.br.y,
          anchors.bl.x, anchors.bl.y,
        ]);
        dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
          OMR_TEMPLATE.anchors.tl.x, OMR_TEMPLATE.anchors.tl.y,
          OMR_TEMPLATE.anchors.tr.x, OMR_TEMPLATE.anchors.tr.y,
          OMR_TEMPLATE.anchors.br.x, OMR_TEMPLATE.anchors.br.y,
          OMR_TEMPLATE.anchors.bl.x, OMR_TEMPLATE.anchors.bl.y,
        ]);
        const perspective = cv.getPerspectiveTransform(srcTri, dstTri);
        cv.warpPerspective(gray, warped, perspective, new cv.Size(OMR_TEMPLATE.width, OMR_TEMPLATE.height), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255));
        perspective.delete();
        cv.threshold(warped, warpedBinary, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
        working = warpedBinary;
      } else {
        working = binary;
      }

      const bubbleScore = (cx, cy, innerRadius = 10, outerRadius = 17) => {
        let innerMarked = 0;
        let innerTotal = 0;
        let ringMarked = 0;
        let ringTotal = 0;
        for (let dy = -outerRadius; dy <= outerRadius; dy += 1) {
          for (let dx = -outerRadius; dx <= outerRadius; dx += 1) {
            const px = Math.round(cx + dx);
            const py = Math.round(cy + dy);
            if (px < 0 || py < 0 || px >= working.cols || py >= working.rows) continue;
            const dist2 = dx * dx + dy * dy;
            if (dist2 > outerRadius * outerRadius) continue;
            const marked = working.ucharPtr(py, px)[0] > 0 ? 1 : 0;
            if (dist2 <= innerRadius * innerRadius) {
              innerMarked += marked;
              innerTotal += 1;
            } else {
              ringMarked += marked;
              ringTotal += 1;
            }
          }
        }
        const innerRatio = innerTotal ? innerMarked / innerTotal : 0;
        const ringRatio = ringTotal ? ringMarked / ringTotal : 0;
        return innerRatio - (ringRatio * 0.38);
      };

      const pickOne = (items, threshold = 0.12, marginThreshold = 0.035) => {
        const ranked = items.sort((a, b) => b.score - a.score);
        const best = ranked[0] || { value: '', score: 0 };
        const second = ranked[1] || { score: 0 };
        return best.score >= threshold && best.score - second.score >= marginThreshold ? best.value : '';
      };

      const detectDigits = ({ startX, startY, columns, rowGap, colGap }) => {
        const digits = [];
        for (let col = 0; col < columns; col += 1) {
          const x = startX + col * colGap;
          const options = Array.from({ length: 10 }, (_, digit) => ({
            value: String(digit),
            score: bubbleScore(x, startY + digit * rowGap, 8, 14),
          }));
          digits.push(pickOne(options, 0.11, 0.025));
        }
        return digits.join('');
      };

      const roll = detectDigits(OMR_TEMPLATE.roll);
      const labels = ['A', 'B', 'C', 'D'];
      const setCode = pickOne(labels.map((label, idx) => ({
        value: label,
        score: bubbleScore(OMR_TEMPLATE.set.startX + idx * OMR_TEMPLATE.set.gap, OMR_TEMPLATE.set.startY, 12, 20),
      })), 0.1, 0.025);

      const answers = [];
      const answerSpec = OMR_TEMPLATE.answers;
      for (let col = 0; col < answerSpec.columns; col += 1) {
        for (let row = 0; row < answerSpec.rowsPerColumn; row += 1) {
          const idx = col * answerSpec.rowsPerColumn + row;
          if (idx >= questionCount) break;
          const y = answerSpec.startY + row * answerSpec.rowGap;
          const x = answerSpec.startX + col * answerSpec.colGap;
          answers.push(pickOne(labels.map((label, optionIndex) => ({
            value: label,
            score: bubbleScore(x + optionIndex * answerSpec.optionGap, y, 8, 14),
          })), 0.1, 0.028));
        }
      }

      return { roll, answers, setCode, templateVersion: OMR_TEMPLATE.version, processedIn: 'browser-opencv' };
    } finally {
      src.delete();
      gray.delete();
      binary.delete();
      warped.delete();
      warpedBinary.delete();
      if (srcTri) srcTri.delete();
      if (dstTri) dstTri.delete();
      if (imageBitmap.close) imageBitmap.close();
    }
  }

  function evaluateDetectedAnswers(answerKey, markedAnswers) {
    let correct = 0;
    let wrong = 0;
    let notAnswered = 0;
    let total = 0;
    let markIndex = 0;
    answerKey.forEach((key) => {
      if (key === 'CQ') return;
      total += 1;
      const marked = markedAnswers[markIndex] || '';
      markIndex += 1;
      if (!marked) notAnswered += 1;
      else if (marked === key) correct += 1;
      else wrong += 1;
    });
    return { correct, wrong, notAnswered, total };
  }

  function buildAnswerBreakdown(answerKey, markedAnswers) {
    const list = [];
    let mcqNo = 0;
    answerKey.forEach((key) => {
      if (key === 'CQ') return;
      mcqNo += 1;
      const marked = markedAnswers[mcqNo - 1] || '';
      list.push({
        qno: mcqNo,
        correct: key,
        marked: marked || '-',
        status: !marked ? 'Not Answered' : (marked === key ? 'Correct' : 'Wrong'),
      });
    });
    return list;
  }

  function upsertOmrAttempt(next) {
    const idx = state.attempts.findIndex((attempt) => attempt.examId === next.examId && attempt.studentId === next.studentId);
    if (idx >= 0) state.attempts[idx] = { ...state.attempts[idx], ...next };
    else state.attempts.unshift({ id: uid('attempt'), ...next });
  }

  async function exportLatestResultWorkbook() {
    const rows = window.__latestOmrBatchResult || [];
    if (!rows.length) return showToast('Process result first, then export.', 'error');
    const XLSX = await ensureXlsxLib();
    const sheet = XLSX.utils.json_to_sheet(rows);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Results');
    XLSX.writeFile(book, 'omr-result-batch.xlsx');
  }

  function initResultAnalysePage() {
    const examSelect = document.getElementById('resultExamSelect');
    const processBtn = document.getElementById('processOmrResultBtn');
    const exportBtn = document.getElementById('exportOmrResultBtn');
    const output = document.getElementById('resultAnalyseOutput');
    const fileInput = document.getElementById('resultOmrImages');
    const preview = document.getElementById('resultOmrPreview');
    if (!examSelect || !processBtn || !exportBtn || !output || !fileInput || !preview) return;
    let omrDrafts = [];
    let omrSearch = '';
    const getFileKey = (file) => `${file.name}__${file.size}__${file.lastModified}`;
    const renderDraftCards = () => {
      if (!omrDrafts.length) {
        preview.innerHTML = '<p class="muted-copy">No OMR image selected yet.</p>';
        return;
      }
      const studentMap = buildStudentRollMap();
      const filtered = omrDrafts.filter((item) => {
        const roll = String(item.editedRoll || '').toLowerCase();
        const student = studentMap.get(item.editedRoll || '') || {};
        const name = String(item.editedName || student.name || '').toLowerCase();
        const setCode = String(item.editedSet || '').toLowerCase();
        const fileName = String(item.file.name || '').toLowerCase();
        const query = omrSearch.toLowerCase();
        if (!query) return true;
        return roll.includes(query) || name.includes(query) || setCode.includes(query) || fileName.includes(query);
      });
      preview.innerHTML = `<label>Search OMR / Roll / Name / Set<input id="omrPreviewSearchInput" type="search" value="${escapeAttr(omrSearch)}" placeholder="Search by roll, name, set, file" /></label><div class="omr-preview-grid">${filtered.map((item, index) => {
        const student = studentMap.get(item.editedRoll || '') || {};
        return `<article class="entity-card entity-card--stacked"><div><h4>OMR ${index + 1}</h4><p class="muted-copy">${escapeHtml(item.file.name)}</p><div class="field-row"><label>Set<input type="text" data-set-edit="${escapeAttr(item.key)}" value="${escapeAttr(item.editedSet || '')}" /></label><label>Roll<input type="text" data-roll-edit="${escapeAttr(item.key)}" value="${escapeAttr(item.editedRoll || '')}" /></label></div><label>Name<input type="text" data-name-edit="${escapeAttr(item.key)}" value="${escapeAttr(item.editedName || student.name || '')}" /></label></div><img src="${item.previewUrl}" alt="OMR preview ${index + 1}" style="width:100%;max-height:220px;object-fit:contain;border:1px solid #d8dee9;border-radius:12px;background:#fff;" /></article>`;
      }).join('')}</div>`;
      preview.querySelector('#omrPreviewSearchInput')?.addEventListener('input', (event) => {
        omrSearch = event.target.value || '';
        renderDraftCards();
      });
      preview.querySelectorAll('[data-roll-edit]').forEach((input) => input.addEventListener('input', (event) => {
        const draft = omrDrafts.find((item) => item.key === event.target.dataset.rollEdit);
        if (!draft) return;
        draft.editedRoll = String(event.target.value || '').trim();
      }));
      preview.querySelectorAll('[data-set-edit]').forEach((input) => input.addEventListener('input', (event) => {
        const draft = omrDrafts.find((item) => item.key === event.target.dataset.setEdit);
        if (!draft) return;
        draft.editedSet = String(event.target.value || '').trim().toUpperCase();
      }));
      preview.querySelectorAll('[data-name-edit]').forEach((input) => input.addEventListener('input', (event) => {
        const draft = omrDrafts.find((item) => item.key === event.target.dataset.nameEdit);
        if (!draft) return;
        draft.editedName = String(event.target.value || '').trim();
      }));
    };

    const syncOmrDrafts = async () => {
      const files = [...(fileInput.files || [])];
      if (!files.length) {
        omrDrafts = [];
        renderDraftCards();
        return;
      }
      const exam = findExam(examSelect.value);
      const answerCount = exam ? deriveStaticAnswerKey(exam).filter((key) => key !== 'CQ').length : 60;
      omrDrafts = [];
      for (const file of files) {
        omrDrafts.push({
          key: getFileKey(file),
          file,
          previewUrl: URL.createObjectURL(file),
          detectedRoll: '',
          editedRoll: '',
          detectedSet: '',
          editedSet: '',
          editedName: '',
        });
      }
      renderDraftCards();
    };
    const params = new URLSearchParams(window.location.search);
    const preselected = params.get('examId') || '';
    examSelect.innerHTML = state.exams.length
      ? state.exams.map((exam) => `<option value="${exam.id}" ${exam.id === preselected ? 'selected' : ''}>${escapeHtml(exam.title)} (${escapeHtml(exam.subject || '')})</option>`).join('')
      : '<option value="">No exam found</option>';
    processBtn.addEventListener('click', async () => {
      const examId = examSelect.value;
      const files = [...fileInput.files];
      if (!examId || !files.length) {
        output.innerHTML = '<p class="muted-copy">Exam select করুন এবং OMR images upload করুন।</p>';
        return;
      }
      const rollOverrides = new Map(omrDrafts.map((item) => [item.key, {
        roll: item.editedRoll || item.detectedRoll || '',
        setCode: item.editedSet || item.detectedSet || '',
        student_name: item.editedName || '',
      }]));
      processBtn.disabled = true;
      output.innerHTML = renderOmrProgress(0, files.length, 'Preparing...');
      try {
        const rows = await analyseOmrBatchForExam(examId, files, rollOverrides, (done, total, fileName) => {
          output.innerHTML = renderOmrProgress(done, total, fileName);
        });
        window.__latestOmrBatchResult = rows;
        output.innerHTML = renderClassWiseResultTable(rows);
      } catch (error) {
        output.innerHTML = `<p class="muted-copy">OMR processing failed: ${escapeHtml(error?.message || 'Unknown error')}</p>`;
      } finally {
        processBtn.disabled = false;
      }
    });
    exportBtn.addEventListener('click', exportLatestResultWorkbook);
    examSelect.addEventListener('change', syncOmrDrafts);
    fileInput.addEventListener('change', syncOmrDrafts);
  }

  function initScanOmrPage() {
    initResultAnalysePage();
    const examSelect = document.getElementById('resultExamSelect');
    const downloadBtn = document.getElementById('scanOmrDownloadBtn');
    const printBtn = document.getElementById('scanOmrPrintBtn');
    const questionPaperBtn = document.getElementById('scanOmrQuestionPaperBtn');
    if (!examSelect || !downloadBtn || !printBtn || !questionPaperBtn) return;

    const getExamId = () => examSelect.value || '';
    downloadBtn.addEventListener('click', () => {
      const examId = getExamId();
      if (!examId) return showToast('Exam select করুন।', 'error');
      const exam = findExam(examId);
      if (!exam) return showToast('Exam not found.', 'error');
      const blob = new Blob([buildOmrSheetHtml(examId)], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${(exam.title || 'exam').replace(/\s+/g, '-').toLowerCase()}-omr-sheet.html`;
      link.click();
      URL.revokeObjectURL(url);
      showToast('OMR sheet downloaded.');
    });
    printBtn.addEventListener('click', () => {
      const examId = getExamId();
      if (!examId) return showToast('Exam select করুন।', 'error');
      printOmrSheet(examId);
    });
    questionPaperBtn.addEventListener('click', () => {
      const examId = getExamId();
      if (!examId) return showToast('Exam select করুন।', 'error');
      printExamPaper(examId);
    });
  }

  function renderOmrUploadPreview(files, target) {
    const list = [...(files || [])];
    if (!list.length) {
      target.innerHTML = '<p class="muted-copy">No OMR image selected yet.</p>';
      return;
    }
    target.innerHTML = `<div class="omr-preview-grid">${list.map((file, index) => {
      const url = URL.createObjectURL(file);
      return `<article class="entity-card entity-card--stacked"><div><h4>OMR ${index + 1}</h4><p class="muted-copy">${escapeHtml(file.name)}</p></div><img src="${url}" alt="OMR preview ${index + 1}" style="width:100%;max-height:220px;object-fit:contain;border:1px solid #d8dee9;border-radius:12px;background:#fff;" /></article>`;
    }).join('')}</div>`;
  }

  function renderOmrProgress(done, total, fileName = '') {
    const safeTotal = Math.max(1, Number(total || 0));
    const safeDone = Math.min(safeTotal, Math.max(0, Number(done || 0)));
    const remaining = Math.max(0, safeTotal - safeDone);
    const percent = Math.round((safeDone / safeTotal) * 100);
    return `<div class="preview-block">
      <h4>Processing OMR with OpenCV</h4>
      <p class="muted-copy">Processed: ${safeDone}/${safeTotal} · Remaining: ${remaining} · ${percent}%</p>
      <div style="height:12px;background:#e5e7eb;border-radius:999px;overflow:hidden;border:1px solid #cbd5e1;">
        <div style="height:100%;width:${percent}%;background:#2563eb;border-radius:999px;transition:width .2s ease;"></div>
      </div>
      ${fileName ? `<p class="muted-copy" style="margin-top:8px;">Current file: ${escapeHtml(fileName)}</p>` : ''}
    </div>`;
  }

  async function analyseOmrBatchForExam(examId, imageFiles, rollOverrides = new Map(), onProgress = null) {
    const exam = findExam(examId);
    if (!exam) return [];
    const defaultKey = deriveStaticAnswerKey(exam);
    const studentMap = buildStudentRollMap();
      const rows = [];
      const getFileKey = (file) => `${file.name}__${file.size}__${file.lastModified}`;
      const cv = await tryLoadOpenCv(onProgress, imageFiles.length);
      for (let fileIndex = 0; fileIndex < imageFiles.length; fileIndex += 1) {
      const file = imageFiles[fileIndex];
      if (onProgress) onProgress(fileIndex, imageFiles.length, file.name);
      await yieldToBrowser();
      let detected = buildEmptyOmrDetection(defaultKey.filter((key) => key !== 'CQ').length, 'fallback');
      try {
        detected = cv
          ? await detectOmrFromImage(file, defaultKey.filter((key) => key !== 'CQ').length, cv)
          : await detectOmrFromImageCanvas(file, defaultKey.filter((key) => key !== 'CQ').length);
      } catch (error) {
        console.warn('Frontend OMR processing failed:', error?.message || error);
      }
      const override = rollOverrides.get(getFileKey(file));
      const finalRoll = typeof override === 'string' ? override : (override?.roll || detected.roll || '');
      const finalSet = typeof override === 'object' ? (override?.setCode || detected.setCode || '') : (detected.setCode || '');
      const student = studentMap.get(finalRoll) || {};
      const finalName = (typeof override === 'object' && override?.student_name) ? override.student_name : (student.name || '');
      const answerKey = deriveStaticAnswerKey(exam, finalSet) || defaultKey;
      const evaluated = evaluateDetectedAnswers(answerKey, detected.answers);
      const breakdown = buildAnswerBreakdown(answerKey, detected.answers);
      if (student.id) {
        const preview = await readFileAsDataUrl(file);
        upsertOmrAttempt({
          examId,
          studentId: student.id,
          score: evaluated.correct,
          total: evaluated.total,
          correctIds: breakdown.filter((item) => item.status === 'Correct').map((item) => String(item.qno)),
          incorrectIds: breakdown.filter((item) => item.status === 'Wrong').map((item) => String(item.qno)),
          studentAnswers: detected.answers,
          answerBreakdown: breakdown,
          omrPreview: preview,
          omrSet: finalSet,
          createdAt: new Date().toISOString(),
        });
      }
      rows.push({
        set: finalSet,
        roll: finalRoll,
        student_name: finalName,
        class: student.className || student.course || 'Unknown',
        institute: student.institute || '',
        phone_number: student.phone || '',
        correct: evaluated.correct,
        wrong: evaluated.wrong,
        not_answered: evaluated.notAnswered,
        total: evaluated.total,
        score: evaluated.correct,
      });
      if (onProgress) onProgress(fileIndex + 1, imageFiles.length, file.name);
      await yieldToBrowser();
    }
    saveState();
    rows.sort((a, b) => (a.class || '').localeCompare(b.class || '') || (b.score - a.score) || (a.wrong - b.wrong) || a.roll.localeCompare(b.roll));
    let currentClass = '';
    let pos = 0;
    rows.forEach((row) => {
      if (row.class !== currentClass) { currentClass = row.class; pos = 0; }
      pos += 1;
      row.merit_position = pos;
      row.percent = row.total ? ((row.correct / row.total) * 100).toFixed(2) : '0.00';
    });
    return rows;
  }

  function buildStudentRollMap() {
    const map = new Map();
    state.students.forEach((student) => {
      const roll = String(student.rollNumber || student.studentId || '').trim();
      if (roll) map.set(roll, student);
    });
    return map;
  }

  function renderClassWiseResultTable(rows) {
    if (!rows.length) return '<p class="muted-copy">No OMR result generated.</p>';
    const grouped = rows.reduce((acc, row) => {
      const key = row.class || 'Unknown';
      if (!acc[key]) acc[key] = [];
      acc[key].push(row);
      return acc;
    }, {});
    return Object.entries(grouped).map(([className, items]) => `<h4>Class: ${escapeHtml(className)}</h4><div class="table-wrap"><table><thead><tr><th>Merit</th><th>Set</th><th>Roll</th><th>Name</th><th>Institute</th><th>Phone</th><th>Correct</th><th>Wrong</th><th>Not Answered</th><th>Total</th><th>%</th></tr></thead><tbody>${items.map((item) => `<tr><td>${item.merit_position}</td><td>${escapeHtml(item.set || '')}</td><td>${escapeHtml(item.roll)}</td><td>${escapeHtml(item.student_name)}</td><td>${escapeHtml(item.institute)}</td><td>${escapeHtml(item.phone_number)}</td><td>${item.correct}</td><td>${item.wrong}</td><td>${item.not_answered}</td><td>${item.total}</td><td>${item.percent}</td></tr>`).join('')}</tbody></table></div>`).join('');
  }

  function getQuestionFilters() {
    const read = (id) => document.getElementById(id)?.value || '';
    return {
      level: read('examFilterLevel'),
      group: read('examFilterGroup'),
      subject: read('examFilterSubject'),
      topic: read('examFilterTopic'),
    };
  }

  function buildExamPaperHtml(examId, options = {}) {
    const includeSolutionQr = options.includeSolutionQr !== false;
    const forceAnswers = options.forceAnswers === true;
    const forceExplanation = options.forceExplanation === true;
    const disableAnswerSheet = options.disableAnswerSheet === true;
    const exam = findExam(examId);
    if (!exam) {
      return '<!DOCTYPE html><html><head><meta charset="utf-8" /><title>Exam Not Found</title></head><body><p>Exam not found.</p></body></html>';
    }
    const variants = buildExamSetVariants(exam);
    const config = variants[0]?.config || state.settings.printConfig;
    const setMarkup = [];
    const answerSheets = [];
    const headerTheme = String(config.headerTheme || 'classic');
    const compactClass = config.compactMode ? 'compact-mode' : '';
    const isPhysicsPaper = String(exam.subject || '').toLowerCase().includes('physics') || String(exam.subject || '').includes('পদার্থ');
    const bodyClass = `${compactClass}${isPhysicsPaper ? `${compactClass ? ' ' : ''}physics-book` : ''}`;

    for (const variant of variants) {
      const { setQuestions, answerKey } = variant;
      const setLabel = variant.setLabel;
      const solutionUrl = getSolutionPublicUrl(exam.id);
      let currentSection = '';
      let mcqSerial = 0;
      let cqSerial = 0;
      const list = setQuestions.map((question, index) => {
        const number = question.type === 'mcq' ? String(++mcqSerial) : `CQ-${++cqSerial}`;
        const displaySubject = question.subject || exam.subject || '';
        const title = question.question || question.stimulus || '';
        const showAnswers = forceAnswers || config.showAnswers;
        const showExplanation = forceExplanation || config.showExplanation;
        const imageBlock = question.image ? `<img class="print-question-image" src="${question.image}" alt="Question image ${index + 1}" />` : '';
        const headingLabel = String(question.topic || question.section || '').trim();
        const sectionHeading = config.showTopicHeading && headingLabel && headingLabel !== currentSection
          ? `<div class="part-heading">${escapeHtml(headingLabel)}</div>`
          : '';
        currentSection = config.showTopicHeading ? (headingLabel || currentSection) : currentSection;
        const questionBody = question.type === 'cq'
          ? (question.subQuestions || []).map((item) => `<div><strong>${escapeHtml(item.label || '')}.</strong> ${formatMathForDisplay(item.prompt || '', { subject: displaySubject })}${showAnswers ? `<div class="answer-block"><strong>Answer:</strong> ${formatExplanationForDisplay(item.answer || '', { subject: displaySubject })}</div>` : ''}</div>`).join('')
          : `<ul class="option-list option-list--grid">${(question.options || []).map((option, optionIndex) => `<li><span class="option-label">${String.fromCharCode(65 + optionIndex)}.</span> <span>${formatMathForDisplay(option, { subject: displaySubject })}</span>${(question.optionImages || [])[optionIndex] ? `<div><img class="print-option-image" src="${(question.optionImages || [])[optionIndex]}" alt="Option ${optionIndex + 1}" /></div>` : ''}</li>`).join('')}</ul>${showAnswers ? `<p class="answer-block"><strong>Answer:</strong> ${String.fromCharCode(65 + (question.correct || 0))}. ${formatMathForDisplay((question.options || [])[question.correct] || '', { subject: displaySubject })}</p>` : ''}`;
        const explanation = showExplanation && question.explanation ? `<p class="explanation-block"><strong>Explanation:</strong> ${formatExplanationForDisplay(question.explanation, { subject: displaySubject })}</p>` : '';
        return `${sectionHeading}<article class="print-question"><h3>${number}. ${formatMathForDisplay(title, { subject: displaySubject })}</h3>${imageBlock}${questionBody}${explanation}</article>`;
      }).join('');

      const headerBlock = buildPaperHeader({
        exam,
        config: { ...config, headerTheme },
        setLabel,
        setCode: variant.setCode,
        includeQr: includeSolutionQr,
        solutionUrl,
      });
      setMarkup.push(`<section class="paper set-paper">${headerBlock}<div class="question-grid">${list || '<p>No questions assigned.</p>'}</div></section>`);

      if (config.includeAnswerSheet && !disableAnswerSheet) {
        const mcqAnswerKey = answerKey.filter((item) => item !== 'CQ');
        const totalRows = 100;
        const perColumn = 25;
        const columns = Array.from({ length: 4 }, (_, colIdx) => {
          const start = colIdx * perColumn + 1;
          const end = Math.min(start + perColumn - 1, totalRows);
          const rows = [];
          for (let qno = start; qno <= end; qno += 1) {
            const key = mcqAnswerKey[qno - 1] || '';
            const bubble = (label) => `<span class="omr-bubble ${key === label ? 'is-correct' : ''}" aria-label="Q${qno}-${label}">${label}</span>`;
            rows.push(`<div class="omr-row"><span class="omr-qno">${qno}.</span><div class="omr-bubbles">${bubble('A')}${bubble('B')}${bubble('C')}${bubble('D')}</div></div>`);
          }
          return `<div class="omr-column"><div class="omr-column-head">Q ${start}-${end}</div>${rows.join('')}</div>`;
        });
        answerSheets.push(`<section class="paper answer-sheet"><div class="omr-sheet-head"><h2>OMR Sheet - ${escapeHtml(setLabel)}</h2><p class="muted-copy">100 MCQ grid (4 columns × 25 rows). প্রতিটি প্রশ্নে একটি bubble ভরাট করুন।</p></div><div class="omr-grid omr-grid--4col">${columns.join('')}</div></section>`);
      }
    }

    return `<!DOCTYPE html><html><head><meta charset="utf-8" /><title>${escapeHtml(exam.title)}</title><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css" /><script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script><script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"></script><script>function renderKaTeXForPrint(){if(!window.renderMathInElement)return;window.renderMathInElement(document.body,{delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}],throwOnError:false,strict:'ignore'});}window.addEventListener('load',()=>setTimeout(renderKaTeXForPrint,60));</script><style>@page{margin:10mm}body{font-family:'Kalpurush','Noto Sans Bengali',Arial,sans-serif;background:#fff;padding:12px;color:#111}.paper{max-width:980px;margin:0 auto 14px auto;padding:12px 14px;border:1px solid #d6dbe3;border-radius:10px;break-inside:avoid-page;position:relative}.set-paper{page-break-before:always}.set-paper:first-of-type{page-break-before:auto}h1,h2,h3{margin:0}.board-head{text-align:center;border:1px solid #d6dbe3;border-radius:10px;padding:6px 8px 8px;margin-bottom:8px;position:relative}.header-logo{position:absolute;top:8px;width:56px;height:56px;object-fit:contain}.header-logo--left{left:8px}.header-logo--right{right:8px}.board-head--modern{background:linear-gradient(140deg,rgba(148,163,184,.12),transparent 65%)}.board-head--minimal{border-width:0 0 2px 0;border-radius:0;padding:4px 0 6px}.board-head--classic{background:#f8fbff}.board-head-grid{display:grid;grid-template-columns:1fr 1.35fr 1fr;gap:10px;align-items:start}.board-col{font-size:12px;text-align:left}.board-col p{margin:2px 0}.board-col--center{text-align:center}.board-col--center h1{font-size:18px;margin-bottom:4px}.board-col__meta{display:flex;flex-direction:column;gap:2px}.board-col__spacer{height:56px}.board-code-box{border:1px solid #cbd5e1;border-radius:8px;background:#fff;padding:4px 8px;display:flex;flex-direction:column;gap:2px}.solution-qr{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font-size:10px;color:#334155}.solution-qr--header{width:72px}.solution-qr img{width:56px;height:56px;border:1px solid #cbd5e1;padding:2px;background:#fff;border-radius:6px}.solution-qr__blank{width:56px;height:56px;border:1px dashed #cbd5e1;border-radius:6px;background:#fff}.instructions{border:1px solid #d6d6d6;background:#f8fafc;padding:5px 7px;border-radius:8px;text-align:center;margin:6px 0 0 0;font-size:11px}.question-grid{column-count:${Math.max(1, Number(config.columns || 1))};column-gap:14px}.part-heading{break-inside:avoid;page-break-inside:avoid;font-weight:800;font-size:14px;border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc;padding:4px 8px;margin:0 0 6px}.print-question{break-inside:avoid;page-break-inside:avoid;padding:0 0 6px;margin:0 0 8px;display:block}.print-question h3{margin-right:2px}.print-question-image{display:block;max-width:100%;max-height:170px;object-fit:contain;border:1px solid #d8dee9;border-radius:8px;background:#fff;margin:6px 0}.print-option-image{display:block;max-width:100%;max-height:62px;object-fit:contain;border:1px solid #d8dee9;border-radius:6px;background:#fff;margin-top:4px}.option-list{list-style:none;padding-left:12px;margin:4px 0}.option-list li{display:flex;gap:6px;margin:2px 0;font-size:13px}.option-list--grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px 14px}.option-list--grid li{margin:0}.option-label{min-width:16px;font-weight:700}.answer-block,.explanation-block{margin-top:4px;font-size:12px}.math-tex{display:inline}.omr-sheet-head{border:1px solid #e2e8f0;border-radius:10px;background:#fdf2f8;padding:8px 10px;margin-bottom:10px}.omr-grid{display:grid;gap:8px 10px;margin-top:10px}.omr-grid--4col{grid-template-columns:repeat(4,minmax(0,1fr))}.omr-column{border:1px solid #f9a8d4;border-radius:8px;padding:6px;background:#fff}.omr-column-head{text-align:center;font-size:11px;font-weight:700;border-bottom:1px solid #fbcfe8;padding-bottom:4px;margin-bottom:4px;color:#9d174d}.omr-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:1px 0}.omr-qno{min-width:24px;font-weight:700;font-size:11px}.omr-bubbles{display:flex;gap:4px}.omr-bubble{width:16px;height:16px;border:1.2px solid #db2777;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:9px;color:#be185d;background:#fff}.omr-bubble.is-correct{background:#9d174d;border-color:#7a1237;color:#fff;box-shadow:inset 0 0 0 2px #be185d,inset 0 0 0 5px rgba(255,255,255,.28)}.math-frac{display:inline-flex;flex-direction:column;align-items:center;vertical-align:middle;line-height:1;font-size:.92em;margin:0 .08em}.math-frac__num{border-bottom:1px solid currentColor;padding:0 .18em .05em}.math-frac__den{padding:.05em .18em 0}.physics-book{font-family:'Times New Roman','STIX Two Text','Noto Serif Bengali','Kalpurush',serif}.physics-book .print-question,.physics-book .print-question h3,.physics-book .print-question p,.physics-book .print-question div,.physics-book .option-list li span,.physics-book .instructions{text-align:justify}.physics-book .katex-display{margin:.55em auto;text-align:center}.physics-book .instructions,.physics-book .explanation-block,.physics-book .answer-block{background:#f8fafc;border:1px solid #dbe6f3;border-radius:8px;padding:4px 6px}.physics-book .formula-card,.physics-book .note-card{background:#f8fafc;border:1px solid #dbe6f3;border-radius:8px;padding:6px 8px;margin:6px 0}.compact-mode .paper{padding:10px 12px}.compact-mode .board-head-grid{gap:8px}.compact-mode .board-col{font-size:11px}.compact-mode .board-col--center h1{font-size:16px}.compact-mode .header-logo{width:42px;height:42px;top:6px}.compact-mode .board-col__spacer{height:42px}.compact-mode .board-code-box{padding:3px 6px}.compact-mode .solution-qr img,.compact-mode .solution-qr__blank{width:44px;height:44px}.compact-mode .question-grid{column-gap:10px}.compact-mode .part-heading{font-size:12px;padding:3px 7px}.compact-mode .print-question{margin:0 0 4px;padding:0 0 4px}.compact-mode h3{font-size:13px;margin-bottom:3px}.compact-mode .print-question-image{max-height:120px;margin:4px 0}.compact-mode .print-option-image{max-height:46px}.compact-mode .option-list{padding-left:10px}.compact-mode .option-list li{margin:1px 0;font-size:12px}.compact-mode .option-list--grid{gap:1px 10px}.compact-mode .option-list--grid li{margin:0}.compact-mode .instructions{font-size:10px;padding:4px 6px}.compact-mode .omr-bubble{width:14px;height:14px;font-size:8px}@media print{body{padding:0}.set-paper,.answer-sheet{page-break-after:always}.set-paper:last-of-type,.answer-sheet:last-of-type{page-break-after:auto}}</style></head><body class="${bodyClass}">${setMarkup.join('')}${answerSheets.join('')}</body></html>`;
  }

  function getSolutionPublicUrl(examId) {
    const configuredBase = String(window.MPQM_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
    const fallbackBase = `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, '')}`;
    const url = configuredBase
      ? new URL('solution-download.html', `${configuredBase}/`)
      : new URL('solution-download.html', fallbackBase);
    url.searchParams.set('examId', examId);
    return url.toString();
  }

  function buildSolutionPaperHtml(examId) {
    return buildExamPaperHtml(examId, {
      includeSolutionQr: false,
      forceAnswers: true,
      forceExplanation: true,
      disableAnswerSheet: true,
    });
  }

  function buildPublishedSnapshot(examItem) {
    return {
      config: structuredClone(state.settings.printConfig),
      questions: (examItem.questionIds || [])
        .map((id) => state.questions.find((question) => question.id === id))
        .filter(Boolean)
        .map((question) => ({
          ...question,
          options: [...(question.options || [])],
          subQuestions: (question.subQuestions || []).map((sub) => ({ ...sub })),
        })),
    };
  }

  function buildPublishedSolutionPayload(examItem) {
    const snapshot = buildPublishedSnapshot(examItem);
    return {
      exam: { ...examItem, published: true, solutionPublished: true, publishedSnapshot: snapshot },
      snapshot,
      publishedAt: new Date().toISOString(),
    };
  }

  async function publishSolutionSnapshot(examItem) {
    await cloudflareRequest('/solutions/publish', {
      method: 'POST',
      body: { exam_id: examItem.id, payload: buildPublishedSolutionPayload(examItem) },
    });
  }

  async function unpublishSolutionSnapshot(examId) {
    await cloudflareRequest('/solutions/unpublish', {
      method: 'POST',
      body: { exam_id: examId },
    });
  }

  async function fetchPublishedSolution(examId) {
    if (!examId || BACKEND !== 'supabase') return null;
    const client = await getSupabaseClient();
    const { data, error } = await client
      .from('published_solutions')
      .select('payload,published')
      .eq('exam_id', examId)
      .eq('published', true)
      .single();
    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }
    return data?.payload || null;
  }

  function installPublishedSolutionPayload(payload) {
    const exam = payload?.exam;
    const snapshot = payload?.snapshot || exam?.publishedSnapshot;
    if (!exam || !snapshot) return null;
    const nextExam = { ...exam, published: true, solutionPublished: true, publishedSnapshot: snapshot };
    upsert(state.exams, nextExam);
    (snapshot.questions || []).forEach((question) => upsert(state.questions, question));
    return nextExam;
  }

  async function initSolutionDownloadPage() {
    const target = document.getElementById('solutionDownloadPage');
    const downloadBtn = document.getElementById('downloadSolutionBtn');
    if (!target || !downloadBtn) return;
    const examId = new URLSearchParams(window.location.search).get('examId') || '';
    const exam = findExam(examId);
    if (!exam) {
      target.innerHTML = '<p class="muted-copy">Exam not found in local database. এই ডিভাইসে exam data import/publish করা না থাকলে solution download করা যাবে না।</p>';
      downloadBtn.disabled = true;
      return;
    }
    if (!exam.solutionPublished) {
      target.innerHTML = `<h3>${escapeHtml(exam.title)}</h3><p class="muted-copy">Solution has not been published yet. Please contact your admin.</p>`;
      downloadBtn.disabled = true;
      return;
    }
    target.innerHTML = `<h3>${escapeHtml(exam.title)}</h3><p class="muted-copy">Solution is published. Tap the button below to download the solution paper.</p>`;
    downloadBtn.disabled = false;
    downloadBtn.addEventListener('click', () => {
      const win = window.open('', '_blank', 'width=1100,height=780');
      if (!win) return showToast('Popup blocked by browser.', 'error');
      win.document.write(buildSolutionPaperHtml(examId));
      win.document.close();
      waitAndPrintMathWindow(win);
    });
  }

  function mergePrintConfig(config = {}) {
    return { ...structuredClone(defaultState).settings.printConfig, ...config };
  }

  function buildQuestionSet(sourceQuestions, config, options = {}) {
    const rng = createSeededRandom(options.seed || '');
    const clonedQuestions = sourceQuestions.map((question) => ({ ...question, options: [...(question.options || [])], subQuestions: question.subQuestions ? question.subQuestions.map((item) => ({ ...item })) : [] }));
    const arrangeByPart = (items, shouldShuffle) => {
      const hasPartTagged = items.some((item) => item.partTagged && item.section);
      if (!hasPartTagged) return shouldShuffle ? shuffleArray(items, rng) : items;
      const buckets = [];
      const index = new Map();
      items.forEach((item) => {
        const key = String(item.section || 'Part').trim() || 'Part';
        if (!index.has(key)) {
          index.set(key, buckets.length);
          buckets.push({ key, items: [] });
        }
        buckets[index.get(key)].items.push(item);
      });
      return buckets.flatMap((bucket) => (shouldShuffle ? shuffleArray(bucket.items, rng) : bucket.items));
    };
    const subjectBuckets = [];
    const subjectIndex = new Map();
    clonedQuestions.forEach((question) => {
      const key = String(question.subject || 'General').trim() || 'General';
      if (!subjectIndex.has(key)) {
        subjectIndex.set(key, subjectBuckets.length);
        subjectBuckets.push({ key, items: [] });
      }
      subjectBuckets[subjectIndex.get(key)].items.push(question);
    });
    const orderedSubjectBuckets = config.shuffleQuestions ? shuffleArray(subjectBuckets, rng) : subjectBuckets;
    let setQuestions = orderedSubjectBuckets.flatMap((bucket) => {
      const cqQuestions = bucket.items.filter((question) => question.type === 'cq');
      const mcqQuestions = bucket.items.filter((question) => question.type !== 'cq');
      return config.shuffleQuestions
        ? [...arrangeByPart(cqQuestions, true), ...arrangeByPart(mcqQuestions, true)]
        : [...arrangeByPart(cqQuestions, false), ...arrangeByPart(mcqQuestions, false)];
    });
    const answerKey = [];
    setQuestions = setQuestions.map((question) => {
      if (question.type !== 'mcq') {
        answerKey.push('CQ');
        return question;
      }
      if (config.shuffleOptions && question.options?.length) {
        const zipped = question.options.map((option, idx) => ({ option, image: (question.optionImages || [])[idx] || '', idx }));
        const shuffled = shuffleArray(zipped, rng);
        const newCorrect = shuffled.findIndex((item) => item.idx === question.correct);
        const next = { ...question, options: shuffled.map((item) => item.option), optionImages: shuffled.map((item) => item.image), correct: newCorrect >= 0 ? newCorrect : 0 };
        answerKey.push(String.fromCharCode(65 + next.correct));
        return next;
      }
      answerKey.push(String.fromCharCode(65 + (question.correct || 0)));
      return question;
    });
    return { setQuestions, answerKey };
  }

  function shuffleArray(items, rng = Math.random) {
    const arr = [...items];
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function createSeededRandom(seedText = '') {
    let seed = 2166136261;
    const text = String(seedText || 'default-seed');
    for (let i = 0; i < text.length; i += 1) {
      seed ^= text.charCodeAt(i);
      seed = Math.imul(seed, 16777619);
    }
    return () => {
      seed += 0x6D2B79F5;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function latexToPlainText(text) {
    const commandMap = {
      alpha: 'α',
      beta: 'β',
      gamma: 'γ',
      delta: 'δ',
      theta: 'θ',
      pi: 'π',
      mu: 'μ',
      infty: '∞',
      times: '×',
      cdot: '·',
      div: '÷',
      pm: '±',
      leq: '≤',
      geq: '≥',
      neq: '≠',
      sec: 'sec',
      csc: 'csc',
      tan: 'tan',
      cos: 'cos',
      sin: 'sin',
      cot: 'cot',
      int: '∫',
      log: 'log',
      ln: 'ln',
    };
    return String(text || '')
      .replace(/\\\((.*?)\\\)/g, '$1')
      .replace(/\\\[(.*?)\\\]/g, '$1')
      .replace(/\$\$(.*?)\$\$/g, '$1')
      .replace(/\$(.*?)\$/g, '$1')
      .replace(/\\(?:d?frac)\{([^{}]+)\}\{([^{}]+)\}/g, '($1)/($2)')
      .replace(/\\sqrt\{([^{}]+)\}/g, 'sqrt($1)')
      .replace(/\\left|\\right/g, '')
      .replace(/\\([a-zA-Z]+)\b/g, (_, cmd) => commandMap[cmd] ?? cmd)
      .replace(/\\([&%$#_{}])/g, '$1')
      .replace(/\\[()[\]]/g, '')
      .replace(/[{}]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function downloadExamPaper(examId) {
    const exam = findExam(examId);
    if (!exam) return showToast('Exam not found.', 'error');
    const blob = new Blob([buildExamPaperHtml(examId)], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${exam.title.replace(/\s+/g, '-').toLowerCase() || 'exam-paper'}.html`;
    link.click();
    URL.revokeObjectURL(url);
    showToast('Exam paper downloaded.');
  }

  function downloadAsDocFile(filename, htmlContent) {
    const blob = new Blob([htmlContent], { type: 'application/msword;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function buildStaticMathHtmlDocument(htmlContent) {
    if (!htmlContent || typeof DOMParser === 'undefined') return htmlContent;
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(String(htmlContent), 'text/html');
      if (typeof window.renderMathInElement === 'function' && doc.body) {
        window.renderMathInElement(doc.body, {
          delimiters: katexDelimiters,
          throwOnError: false,
          strict: 'ignore',
        });
      }
      doc.querySelectorAll('script').forEach((node) => node.remove());
      return `<!DOCTYPE html>${doc.documentElement.outerHTML}`;
    } catch {
      return htmlContent;
    }
  }

  function downloadExamPaperDocs(examId) {
    const exam = findExam(examId);
    if (!exam) return showToast('Exam not found.', 'error');
    const filename = `${exam.title.replace(/\s+/g, '-').toLowerCase() || 'question-paper'}.doc`;
    const html = buildStaticMathHtmlDocument(buildExamPaperHtml(examId, { includeSolutionQr: false }));
    downloadAsDocFile(filename, html);
    showToast('Question paper docs exported.');
  }

  function downloadSolutionPaperDocs(examId) {
    const exam = findExam(examId);
    if (!exam) return showToast('Exam not found.', 'error');
    const filename = `${exam.title.replace(/\s+/g, '-').toLowerCase() || 'solution-paper'}-solution.doc`;
    const html = buildStaticMathHtmlDocument(buildSolutionPaperHtml(examId));
    downloadAsDocFile(filename, html);
    showToast('Solution paper docs exported.');
  }

  function waitAndPrintMathWindow(win, options = {}) {
    const timeoutMs = Number(options.timeoutMs || 5000);
    const renderDelayMs = Number(options.renderDelayMs || 180);
    const startedAt = Date.now();

    const finalizePrint = () => {
      if (!win || win.closed) return;
      win.focus();
      win.print();
    };

    const tryRender = () => {
      if (!win || win.closed) return;
      const doc = win.document;
      if (!doc) return setTimeout(tryRender, 40);

      if (doc.readyState !== 'complete') {
        if (Date.now() - startedAt > timeoutMs) return finalizePrint();
        return setTimeout(tryRender, 60);
      }

      if (typeof win.renderMathInElement === 'function') {
        try {
          win.renderMathInElement(doc.body, {
            delimiters: katexDelimiters,
            throwOnError: false,
            strict: 'ignore',
          });
        } catch (_) {
          // fallback to printing even if render fails
        }
        return setTimeout(finalizePrint, renderDelayMs);
      }

      if (win.MathJax?.typesetPromise) {
        return win.MathJax.typesetPromise()
          .catch(() => null)
          .finally(() => setTimeout(finalizePrint, renderDelayMs));
      }

      if (Date.now() - startedAt > timeoutMs) return finalizePrint();
      return setTimeout(tryRender, 80);
    };

    setTimeout(tryRender, 40);
  }

  function printExamPaper(examId) {
    if (!findExam(examId)) return showToast('Exam not found.', 'error');
    const win = window.open('', '_blank', 'width=980,height=720');
    if (!win) return showToast('Popup blocked by browser.', 'error');
    win.document.write(buildExamPaperHtml(examId));
    win.document.close();
    waitAndPrintMathWindow(win);
  }

  function buildOmrSheetHtml(examId) {
    const exam = findExam(examId);
    if (!exam) return '<!DOCTYPE html><html><head><meta charset="utf-8" /><title>OMR Not Found</title></head><body><p>Exam not found.</p></body></html>';
    const variants = buildExamSetVariants(exam);
    const config = variants[0]?.config || state.settings.printConfig;
    const pages = [];
    const buildDigitColumns = (digits, name) => {
      const columns = Array.from({ length: digits }, (_, colIndex) => {
        const bubbles = Array.from({ length: 10 }, (_, digit) => `<span class="digit-bubble">${digit}</span>`).join('');
        return `<div class="digit-col"><div class="digit-col__write"></div>${bubbles}</div>`;
      }).join('');
      return `<div class="digit-card"><div class="digit-card__title">${name}</div><div class="digit-card__hint">উপরে ঘরে সংখ্যা লিখুন, পরে নিচে একই সংখ্যা ভরাট করুন</div><div class="digit-cols" style="--digit-count:${digits}">${columns}</div></div>`;
    };
    for (const variant of variants) {
      const { answerKey } = variant;
      const mcqAnswerKey = answerKey.filter((item) => item !== 'CQ');
      const setLabel = variant.setCode;
      const densityClass = 'is-dense-3';
      const totalRows = 100;
      const colSize = 25;
      const questionRows = `<div class="omr-columns">${Array.from({ length: 4 }, (_, col) => {
        const columnRows = Array.from({ length: colSize }, (_, row) => {
          const idx = col * colSize + row;
          if (idx >= totalRows) return '';
          return `<div class="omr-q-row"><span class="qno">${idx + 1}.</span><div class="bubble-group"><span>A</span><span>B</span><span>C</span><span>D</span></div></div>`;
        }).join('');
        return `<div class="omr-col">${columnRows}</div>`;
      }).join('')}</div>`;
      pages.push(`<section class="omr-page ${densityClass}"><div class="timing-mark timing-mark--tl"></div><div class="timing-mark timing-mark--tr"></div><div class="timing-mark timing-mark--bl"></div><div class="timing-mark timing-mark--br"></div><div class="timing-rail"><span></span><span></span><span></span><span></span><span></span></div><header class="board-head board-head--${escapeAttr(config.headerTheme || 'classic')}"><h1>${formatMathForDisplay(config.headerTitle)}</h1><h2>${formatMathForDisplay(config.paperTitle || exam.title)}</h2><div class="board-meta"><span><strong>Set:</strong> ${escapeHtml(setLabel)}</span><span><strong>Class:</strong> ${formatMathForDisplay(config.classLabel || 'N/A')}</span><span><strong>Exam Code:</strong> ${formatMathForDisplay(config.examCode || 'N/A')}</span></div><p class="paper-meta">${formatMathForDisplay(config.paperSubject || exam.subject)} · ${escapeHtml(config.paperDate || exam.examDate)} · ${escapeHtml(config.paperType || exam.examType)}</p></header><div class="omr-warning">উত্তরপত্রে নির্দিষ্ট স্থান ব্যতীত অন্য কোথাও লেখা যাবে না</div><div class="omr-layout"><div class="omr-left"><div class="omr-table-head"><span>প্রশ্ন নম্বর</span><span>উত্তর</span></div><div class="omr-question-grid">${questionRows || '<p>No assigned question found.</p>'}</div></div><div class="omr-right"><div class="id-grid">${buildDigitColumns(6, 'রোল নম্বর')}${buildDigitColumns(8, 'রেজিস্ট্রেশন নম্বর')}</div><div class="set-code-box"><div class="digit-card"><div class="digit-card__title">সেট কোড</div><div class="set-bubbles"><span class="set-bubble ${setLabel === 'A' || setLabel === '1' ? 'is-active' : ''}">A</span><span class="set-bubble ${setLabel === 'B' || setLabel === '2' ? 'is-active' : ''}">B</span><span class="set-bubble ${setLabel === 'C' || setLabel === '3' ? 'is-active' : ''}">C</span><span class="set-bubble ${setLabel === 'D' || setLabel === '4' ? 'is-active' : ''}">D</span></div></div></div><div class="name-card"><div><strong>শিক্ষার্থীর নাম</strong></div><div class="line"></div><div><strong>ফোন নম্বর</strong></div><div class="line"></div><div><strong>শিক্ষার্থীর স্বাক্ষর</strong></div><div class="line"></div></div></div></div><div class="omr-note"><strong>নির্দেশাবলী:</strong> কালো বল পয়েন্ট কলম দিয়ে বৃত্ত সম্পূর্ণ ভরাট করুন।</div></section>`);
    }
    return `<!DOCTYPE html><html><head><meta charset="utf-8" /><title>${escapeHtml(exam.title)} OMR</title><style>@page{size:A4 portrait;margin:6mm}body{font-family:'Kalpurush','Noto Sans Bengali',Arial,sans-serif;color:#111;padding:8px;background:#fff}.omr-page{width:198mm;height:285mm;max-width:198mm;margin:0 auto 8px auto;border:2px solid #111;padding:8px 14mm 8px 14mm;box-sizing:border-box;page-break-after:always;page-break-inside:avoid;break-inside:avoid;overflow:hidden;position:relative}.omr-page:last-child{page-break-after:auto}.timing-mark{position:absolute;width:11mm;height:11mm;background:#000;z-index:3}.timing-mark--tl{left:0.8mm;top:0.8mm}.timing-mark--tr{right:0.8mm;top:0.8mm}.timing-mark--bl{left:0.8mm;bottom:0.8mm}.timing-mark--br{right:0.8mm;bottom:0.8mm}.timing-rail{position:absolute;left:0.8mm;top:24mm;bottom:24mm;display:flex;flex-direction:column;justify-content:space-between;z-index:3}.timing-rail span{width:8mm;height:8mm;background:#000;display:block}.board-head{text-align:center;border:1px solid #d6dbe3;border-radius:10px;padding:10px 8px;margin-bottom:10px}.board-head--modern{background:linear-gradient(140deg,rgba(148,163,184,.12),transparent 65%)}.board-head--minimal{border-width:0 0 2px 0;border-radius:0;padding:6px 0}.board-head--classic{background:#f8fbff}.board-head h1{margin:0;font-size:24px}.board-head h2{margin:2px 0 6px 0;font-size:18px}.board-meta{display:flex;justify-content:center;gap:12px;flex-wrap:wrap;font-size:12px;margin-bottom:4px}.paper-meta{text-align:center;font-size:12px;color:#444;margin:0}.omr-warning{text-align:center;border:2px solid #111;background:#fff0fb;color:#861657;font-weight:700;font-size:13px;padding:6px;margin:10px 0}.omr-layout{display:grid;grid-template-columns:1.5fr 1fr;gap:10px;align-items:start}.omr-left{border:1px solid #e879c4;padding:8px;background:#fff9fd}.omr-table-head{display:grid;grid-template-columns:88px 1fr;font-weight:700;font-size:13px;background:#ffd6f1;border:1px solid #e879c4;padding:4px 6px;margin-bottom:6px}.omr-question-grid{display:block}.omr-columns{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px 6px}.omr-col{display:grid;gap:4px}.omr-q-row{display:flex;align-items:center;gap:5px;border:1px solid #f3b0dc;background:#fff;padding:1px 2px}.qno{min-width:14px;font-weight:700;font-size:10px}.bubble-group{display:flex;gap:2px}.bubble-group span{width:11px;height:11px;border:1px solid #c02686;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:7px;color:#9d174d}.omr-right{display:flex;flex-direction:column;gap:6px}.id-grid{display:grid;grid-template-columns:1fr;gap:6px}.digit-card{border:1px solid #e879c4;background:#fff9fd;padding:5px}.digit-card__title{font-weight:700;font-size:12px;text-align:center;margin-bottom:1px}.digit-card__hint{text-align:center;font-size:9px;color:#7a1e4f;margin-bottom:3px}.digit-cols{display:grid;grid-template-columns:repeat(var(--digit-count),minmax(0,1fr));gap:3px}.digit-col{display:flex;flex-direction:column;align-items:center;gap:1px}.digit-col__write{width:15px;height:15px;border:1px solid #7a1e4f;background:#fff}.digit-bubble{width:15px;height:15px;border:1px solid #c02686;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:9px;color:#9d174d}.set-code-box .set-bubbles{display:flex;justify-content:center;gap:8px;padding:2px 0}.set-bubble{width:20px;height:20px;border:1px solid #c02686;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;color:#9d174d}.set-bubble.is-active{background:#c02686;color:#fff}.name-card{border:1px solid #e879c4;background:#fff;padding:6px;display:grid;grid-template-columns:1fr;gap:4px;font-size:11px}.line{border-bottom:1px solid #444;height:12px}.omr-note{margin-top:6px;font-size:11px;border-top:1px dashed #999;padding-top:5px}.omr-page.is-dense-1 .omr-columns{gap:4px 6px}.omr-page.is-dense-2 .bubble-group span{width:14px;height:14px;font-size:8px}.omr-page.is-dense-2 .qno{min-width:16px;font-size:10px}.omr-page.is-dense-3 .omr-layout{grid-template-columns:1.7fr 1fr;gap:7px}.omr-page.is-dense-3 .omr-columns{gap:3px 5px}.omr-page.is-dense-3 .omr-q-row{gap:3px;padding:1px 2px}.omr-page.is-dense-3 .bubble-group{gap:2px}.omr-page.is-dense-3 .bubble-group span{width:11px;height:11px;font-size:7px}.omr-page.is-dense-3 .qno{min-width:12px;font-size:9px}.omr-page.is-dense-3 .board-head h1{font-size:18px}.omr-page.is-dense-3 .board-head h2{font-size:13px}@media print{body{padding:0}}</style></head><body>${pages.join('')}</body></html>`;
  }

  function buildOmrSheetHtml(examId) {
    const exam = findExam(examId);
    if (!exam) return '<!DOCTYPE html><html><head><meta charset="utf-8" /><title>OMR Not Found</title></head><body><p>Exam not found.</p></body></html>';
    const variants = buildExamSetVariants(exam);
    const config = variants[0]?.config || state.settings.printConfig;
    const svgText = (text, x, y, size = 36, extra = '') => `<text x="${x}" y="${y}" font-size="${size}" ${extra}>${escapeHtml(String(text || ''))}</text>`;
    const bubble = (x, y, label, active = false, r = 14) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${active ? '#111' : '#fff'}" stroke="#111" stroke-width="3"/><text x="${x}" y="${y + 5}" font-size="${r}" text-anchor="middle" fill="${active ? '#fff' : '#111'}">${label}</text>`;
    const marker = (point) => `<rect x="${point.x - 58}" y="${point.y - 58}" width="116" height="116" fill="#000"/>`;
    const buildDigitGrid = (spec, title) => {
      const heads = Array.from({ length: spec.columns }, (_, col) => {
        const x = spec.startX + col * spec.colGap;
        return `<rect x="${x - 17}" y="${spec.startY - 70}" width="34" height="34" fill="#fff" stroke="#111" stroke-width="2"/>`;
      }).join('');
      const bubbles = Array.from({ length: spec.columns }, (_, col) => {
        const x = spec.startX + col * spec.colGap;
        return Array.from({ length: 10 }, (_, digit) => bubble(x, spec.startY + digit * spec.rowGap, digit, false, 13)).join('');
      }).join('');
      return `${svgText(title, spec.startX - 50, spec.startY - 115, 30, 'font-weight="700"')}${heads}${bubbles}`;
    };
    const buildAnswerGrid = (questionCount) => {
      const spec = OMR_TEMPLATE.answers;
      return Array.from({ length: spec.columns }, (_, col) => {
        return Array.from({ length: spec.rowsPerColumn }, (_, row) => {
          const qno = col * spec.rowsPerColumn + row + 1;
          if (qno > questionCount) return '';
          const x = spec.startX + col * spec.colGap;
          const y = spec.startY + row * spec.rowGap;
          return `${svgText(`${qno}.`, x - 58, y + 7, 22, 'font-weight="700"')}${['A', 'B', 'C', 'D'].map((label, idx) => bubble(x + idx * spec.optionGap, y, label, false, 13)).join('')}`;
        }).join('');
      }).join('');
    };
    const pages = variants.map((variant) => {
      const mcqCount = variant.answerKey.filter((item) => item !== 'CQ').length || 100;
      const setLabel = String(variant.setCode || variant.setLabel || 'A').toUpperCase();
      const setSpec = OMR_TEMPLATE.set;
      return `<section class="omr-svg-page"><svg viewBox="0 0 ${OMR_TEMPLATE.width} ${OMR_TEMPLATE.height}" xmlns="http://www.w3.org/2000/svg" data-template="${OMR_TEMPLATE.version}">
        <rect x="0" y="0" width="${OMR_TEMPLATE.width}" height="${OMR_TEMPLATE.height}" fill="#fff"/>
        ${marker(OMR_TEMPLATE.anchors.tl)}${marker(OMR_TEMPLATE.anchors.tr)}${marker(OMR_TEMPLATE.anchors.bl)}${marker(OMR_TEMPLATE.anchors.br)}
        <rect x="135" y="135" width="2210" height="3238" fill="none" stroke="#111" stroke-width="5"/>
        ${svgText(config.headerTitle || 'MegaPrep Examination', 1240, 260, 58, 'text-anchor="middle" font-weight="800"')}
        ${svgText(config.paperTitle || exam.title, 1240, 330, 44, 'text-anchor="middle" font-weight="700"')}
        ${svgText(`Set: ${setLabel}    Class: ${config.classLabel || ''}    Exam Code: ${config.examCode || ''}`, 1240, 390, 30, 'text-anchor="middle"')}
        ${svgText(`${config.paperSubject || exam.subject || ''}    ${config.paperDate || exam.examDate || ''}    ${config.paperType || exam.examType || ''}`, 1240, 440, 26, 'text-anchor="middle"')}
        <rect x="250" y="520" width="1980" height="70" fill="#fff" stroke="#111" stroke-width="4"/>
        ${svgText('Fill bubbles completely with black ball-point pen. Do not write outside marked boxes.', 1240, 567, 28, 'text-anchor="middle" font-weight="700"')}
        <line x1="1570" y1="650" x2="1570" y2="3180" stroke="#111" stroke-width="3"/>
        ${svgText('Question', 250, 720, 30, 'font-weight="700"')}${svgText('Answer', 430, 720, 30, 'font-weight="700"')}
        ${buildAnswerGrid(Math.min(mcqCount, 100))}
        ${buildDigitGrid(OMR_TEMPLATE.roll, 'Roll Number')}
        ${buildDigitGrid(OMR_TEMPLATE.registration, 'Registration Number')}
        ${svgText('Set Code', setSpec.startX - 20, setSpec.startY - 75, 30, 'font-weight="700"')}
        ${['A', 'B', 'C', 'D'].map((label, idx) => bubble(setSpec.startX + idx * setSpec.gap, setSpec.startY, label, label === setLabel, 22)).join('')}
        ${svgText('Student Name', 1720, 2385, 28, 'font-weight="700"')}<line x1="1720" y1="2430" x2="2250" y2="2430" stroke="#111" stroke-width="3"/>
        ${svgText('Phone', 1720, 2515, 28, 'font-weight="700"')}<line x1="1720" y1="2560" x2="2250" y2="2560" stroke="#111" stroke-width="3"/>
        ${svgText('Signature', 1720, 2645, 28, 'font-weight="700"')}<line x1="1720" y1="2690" x2="2250" y2="2690" stroke="#111" stroke-width="3"/>
        ${svgText(`Template: ${OMR_TEMPLATE.version}`, 220, 3335, 22)}
      </svg></section>`;
    });
    return `<!DOCTYPE html><html><head><meta charset="utf-8" /><title>${escapeHtml(exam.title)} OMR</title><style>@page{size:A4 portrait;margin:5mm}body{margin:0;background:#fff;font-family:Arial,sans-serif}.omr-svg-page{width:200mm;height:283mm;margin:0 auto;page-break-after:always;break-inside:avoid}.omr-svg-page:last-child{page-break-after:auto}svg{display:block;width:100%;height:100%}text{font-family:Arial,'Noto Sans Bengali',sans-serif}@media print{body{padding:0}.omr-svg-page{margin:0}}</style></head><body>${pages.join('')}</body></html>`;
  }

  function printOmrSheet(examId) {
    if (!findExam(examId)) return showToast('Exam not found.', 'error');
    const win = window.open('', '_blank', 'width=980,height=720');
    if (!win) return showToast('Popup blocked by browser.', 'error');
    win.document.write(buildOmrSheetHtml(examId));
    win.document.close();
    win.focus();
    win.print();
  }

  function findExam(id) { return state.exams.find((item) => item.id === id); }

  function initStudentsPage() {
    document.getElementById('studentForm').addEventListener('submit', saveStudent);
    document.getElementById('studentCsvFile').addEventListener('change', async (e) => { const file = e.target.files?.[0]; if (file) document.getElementById('studentCsvText').value = await file.text(); });
    document.getElementById('importStudentsBtn').addEventListener('click', importStudents);
    document.getElementById('importStudentsXlsxBtn')?.addEventListener('click', importStudentsFromXlsx);
    document.getElementById('studentSearch')?.addEventListener('input', () => renderStudents());
    document.getElementById('studentClassFilter')?.addEventListener('change', () => renderStudents());
    document.getElementById('exportStudentsAllBtn')?.addEventListener('click', () => exportStudentsSheet());
    document.getElementById('exportStudentsClassBtn')?.addEventListener('click', () => exportStudentsSheet(document.getElementById('studentClassFilter')?.value || ''));
    renderStudents();
  }

  function saveStudent(event) {
    event.preventDefault();
    state.students.unshift({
      id: uid('student'),
      name: document.getElementById('studentName').value.trim(),
      rollNumber: document.getElementById('studentRollNumber').value.trim(),
      className: document.getElementById('studentClass').value.trim(),
      institute: document.getElementById('studentInstitute').value.trim(),
      phone: document.getElementById('studentPhone').value.trim(),
      active: true,
      createdAt: new Date().toISOString(),
    });
    saveState();
    event.target.reset();
    renderStudents();
    showToast('Student created.');
  }

  function importStudents() {
    const rows = parseCSVRows(document.getElementById('studentCsvText').value);
    rows.forEach((row) => {
      const roll = row.roll_number || row.roll || row.studentid || row.studentId || '';
      if (!(row.student_name || row.name || roll)) return;
      state.students.unshift({
        id: uid('student'),
        name: row.student_name || row.name || '',
        rollNumber: roll,
        className: row.class || row.course || '',
        institute: row.institute || '',
        phone: row.phone_number || row.phone || '',
        active: true,
        createdAt: new Date().toISOString(),
      });
    });
    saveState();
    renderStudents();
    showToast('Students imported from CSV.');
  }

  async function importStudentsFromXlsx() {
    const file = document.getElementById('studentXlsxFile')?.files?.[0];
    if (!file) return showToast('Upload an XLSX file first.', 'error');
    const students = await readStudentListFromXlsx(file);
    students.forEach((row, roll) => {
      state.students.unshift({
        id: uid('student'),
        name: row.student_name || '',
        rollNumber: roll,
        className: row.class || '',
        institute: row.institute || '',
        phone: row.phone_number || '',
        active: true,
        createdAt: new Date().toISOString(),
      });
    });
    saveState();
    renderStudents();
    showToast('Students imported from XLSX.');
  }

  function renderStudents() {
    const target = document.getElementById('studentList');
    const counter = document.getElementById('studentClassCount');
    if (!target) return;
    if (!state.students.length) return target.innerHTML = emptyState('No students added yet.');
    const query = (document.getElementById('studentSearch')?.value || '').trim().toLowerCase();
    const classFilter = document.getElementById('studentClassFilter')?.value || '';
    const filtered = state.students.filter((student) => {
      if (classFilter && (student.className || student.course || '') !== classFilter) return false;
      if (!query) return true;
      return [student.name, student.rollNumber, student.phone, student.className, student.institute].some((item) => String(item || '').toLowerCase().includes(query));
    });
    if (!filtered.length) {
      target.innerHTML = emptyState('No student matched your search.');
      if (counter) counter.textContent = 'No student in current filter.';
      return;
    }
    const grouped = filtered.reduce((acc, student) => {
      const key = student.className || student.course || 'Unassigned';
      if (!acc[key]) acc[key] = [];
      acc[key].push(student);
      return acc;
    }, {});
    if (counter) counter.textContent = Object.entries(grouped).map(([name, list]) => `${name}: ${list.length}`).join(' | ');
    target.innerHTML = Object.entries(grouped).map(([className, items]) => `<section class="preview-surface preview-surface--small"><h4>Class: ${escapeHtml(className)}</h4>${items.map((student) => `<article class="entity-card entity-card--stacked"><div class="entity-card__head"><div><h4>${escapeHtml(student.name)}</h4><p>Roll: ${escapeHtml(student.rollNumber || student.studentId || '')} · ${escapeHtml(student.institute || '')} · ${escapeHtml(student.phone || student.email || '')}</p></div><span class="status-pill ${student.active ? 'is-live' : ''}">${student.active ? 'Active' : 'Inactive'}</span></div><div class="entity-actions"><a class="toolbar-button" href="student-profile.html?studentId=${student.id}">View Profile</a><button class="toolbar-button" data-toggle-student="${student.id}">${student.active ? 'Deactivate' : 'Activate'}</button><button class="toolbar-button toolbar-button--danger" data-delete-student="${student.id}">Delete</button></div></article>`).join('')}</section>`).join('');
    target.querySelectorAll('[data-toggle-student]').forEach((button) => button.addEventListener('click', () => { const student = state.students.find((item) => item.id === button.dataset.toggleStudent); student.active = !student.active; saveState(); renderStudents(); }));
    target.querySelectorAll('[data-delete-student]').forEach((button) => button.addEventListener('click', () => { state.students = state.students.filter((item) => item.id !== button.dataset.deleteStudent); saveState(); renderStudents(); }));
    target.querySelectorAll('[data-view-student]').forEach((card) => card.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      renderStudentProfile(card.dataset.viewStudent);
    }));
    if (profile && !profile.innerHTML.trim()) profile.innerHTML = '<p class="muted-copy">Select a student to see profile and exam results.</p>';
  }

  function renderStudentProfile(studentId) {
    const target = document.getElementById('studentProfile');
    if (!target) return;
    const student = state.students.find((item) => item.id === studentId);
    if (!student) return target.innerHTML = '<p class="muted-copy">Student not found.</p>';
    const attempts = state.attempts.filter((attempt) => attempt.studentId === studentId);
    const rows = attempts.map((attempt) => {
      const exam = findExam(attempt.examId);
      const pct = attempt.total ? ((attempt.score / attempt.total) * 100).toFixed(2) : '0.00';
      return `<tr><td>${escapeHtml(exam?.title || attempt.examId)}</td><td>${attempt.score}/${attempt.total}</td><td>${pct}%</td><td>${new Date(attempt.createdAt).toLocaleDateString()}</td></tr>`;
    }).join('');
    target.innerHTML = `<h4>${escapeHtml(student.name)} · Profile</h4><p>Roll: ${escapeHtml(student.rollNumber || '')} · Class: ${escapeHtml(student.className || '')} · Phone: ${escapeHtml(student.phone || '')}</p><div class="table-wrap"><table><thead><tr><th>Exam</th><th>Score</th><th>Percent</th><th>Date</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No exam result yet.</td></tr>'}</tbody></table></div>`;
  }

  function buildStudentProfileMarkup(studentId) {
    const student = state.students.find((item) => item.id === studentId);
    if (!student) return '<p class="muted-copy">Student not found.</p>';
    const attempts = state.attempts.filter((attempt) => attempt.studentId === studentId);
    const rows = attempts.map((attempt) => {
      const exam = findExam(attempt.examId);
      const pct = attempt.total ? ((attempt.score / attempt.total) * 100).toFixed(2) : '0.00';
      return `<tr><td>${escapeHtml(exam?.title || attempt.examId)}</td><td>${attempt.score}/${attempt.total}</td><td>${pct}%</td><td>${new Date(attempt.createdAt).toLocaleDateString()}</td></tr>`;
    }).join('');
    return `<div class="result-card"><h2>MegaPrep · Student Result Card</h2><p><strong>Name:</strong> ${escapeHtml(student.name)} | <strong>Roll:</strong> ${escapeHtml(student.rollNumber || '')} | <strong>Class:</strong> ${escapeHtml(student.className || '')}</p><p><strong>Institute:</strong> ${escapeHtml(student.institute || '')} | <strong>Phone:</strong> ${escapeHtml(student.phone || '')}</p><div class="table-wrap"><table><thead><tr><th>Exam</th><th>Score</th><th>Percent</th><th>Date</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No exam result yet.</td></tr>'}</tbody></table></div></div>`;
  }

  function initStudentProfilePage() {
    const target = document.getElementById('studentProfilePage');
    const printBtn = document.getElementById('printStudentMarksheetBtn');
    if (!target || !printBtn) return;
    const params = new URLSearchParams(window.location.search);
    const studentId = params.get('studentId') || '';
    target.innerHTML = buildStudentProfileMarkup(studentId);
    printBtn.addEventListener('click', () => {
      const win = window.open('', '_blank', 'width=1000,height=800');
      if (!win) return showToast('Popup blocked by browser.', 'error');
      win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Marksheet</title><link rel="stylesheet" href="styles.css"></head><body>${buildStudentProfileMarkup(studentId)}</body></html>`);
      win.document.close();
      win.print();
    });
  }

  async function exportStudentsSheet(className = '') {
    const XLSX = await ensureXlsxLib();
    const rows = state.students
      .filter((student) => !className || (student.className || student.course || '') === className)
      .map((student) => ({
        roll_number: student.rollNumber || '',
        student_name: student.name || '',
        class: student.className || student.course || '',
        institute: student.institute || '',
        phone_number: student.phone || '',
      }));
    if (!rows.length) return showToast('No student found for export.', 'error');
    const sheet = XLSX.utils.json_to_sheet(rows);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, className || 'All Students');
    XLSX.writeFile(book, className ? `${className.replace(/\s+/g, '-').toLowerCase()}-students.xlsx` : 'all-students.xlsx');
  }

  function buildStudentProfileMarkup(studentId) {
    const student = state.students.find((item) => item.id === studentId);
    if (!student) return '<p class="muted-copy">Student not found.</p>';
    const attempts = state.attempts.filter((attempt) => attempt.studentId === studentId);
    const rows = attempts.map((attempt) => {
      const exam = findExam(attempt.examId);
      const pct = attempt.total ? ((attempt.score / attempt.total) * 100).toFixed(2) : '0.00';
      return `<tr><td>${escapeHtml(exam?.title || attempt.examId)}</td><td>${attempt.score}/${attempt.total}</td><td>${pct}%</td><td>${new Date(attempt.createdAt).toLocaleDateString()}</td></tr>`;
    }).join('');
    const totalExams = attempts.length;
    const avgPercent = attempts.length ? (attempts.reduce((sum, item) => sum + ((item.total ? item.score / item.total : 0) * 100), 0) / attempts.length).toFixed(2) : '0.00';
    return `<section class="result-card marksheet-onepage"><header class="result-card__head"><h1>MegaPrep Result Card</h1><p>Professional Academic Transcript</p></header><div class="result-card__meta"><div><strong>Student Name</strong><span>${escapeHtml(student.name)}</span></div><div><strong>Roll Number</strong><span>${escapeHtml(student.rollNumber || '')}</span></div><div><strong>Class</strong><span>${escapeHtml(student.className || '')}</span></div><div><strong>Institute</strong><span>${escapeHtml(student.institute || '')}</span></div><div><strong>Phone</strong><span>${escapeHtml(student.phone || '')}</span></div></div><div class="result-card__stats"><article><strong>${totalExams}</strong><span>Total Exams</span></article><article><strong>${avgPercent}%</strong><span>Average %</span></article></div><div class="table-wrap"><table><thead><tr><th>Exam</th><th>Score</th><th>Percent</th><th>Date</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No exam result yet.</td></tr>'}</tbody></table></div></section>`;
  }

  function initStudentProfilePage() {
    const target = document.getElementById('studentProfilePage');
    const printBtn = document.getElementById('printStudentMarksheetBtn');
    if (!target || !printBtn) return;
    const params = new URLSearchParams(window.location.search);
    const studentId = params.get('studentId') || '';
    target.innerHTML = buildStudentProfileMarkup(studentId);
    printBtn.addEventListener('click', () => {
      const win = window.open('', '_blank', 'width=1000,height=800');
      if (!win) return showToast('Popup blocked by browser.', 'error');
      win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Marksheet</title><link rel="stylesheet" href="styles.css"></head><body>${buildStudentProfileMarkup(studentId)}</body></html>`);
      win.document.close();
      win.print();
    });
  }

  async function exportStudentsSheet(className = '') {
    const XLSX = await ensureXlsxLib();
    const rows = state.students
      .filter((student) => !className || (student.className || student.course || '') === className)
      .map((student) => ({
        roll_number: student.rollNumber || '',
        student_name: student.name || '',
        class: student.className || student.course || '',
        institute: student.institute || '',
        phone_number: student.phone || '',
      }));
    if (!rows.length) return showToast('No student found for export.', 'error');
    const sheet = XLSX.utils.json_to_sheet(rows);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, className || 'All Students');
    XLSX.writeFile(book, className ? `${className.replace(/\s+/g, '-').toLowerCase()}-students.xlsx` : 'all-students.xlsx');
  }

  function buildStudentProfileMarkup(studentId) {
    const student = state.students.find((item) => item.id === studentId);
    if (!student) return '<p class="muted-copy">Student not found.</p>';
    const attempts = state.attempts.filter((attempt) => attempt.studentId === studentId);
    const rows = attempts.map((attempt) => {
      const exam = findExam(attempt.examId);
      const highest = state.attempts
        .filter((item) => item.examId === attempt.examId)
        .reduce((max, item) => Math.max(max, Number(item.score || 0)), 0);
      const pct = attempt.total ? ((attempt.score / attempt.total) * 100).toFixed(2) : '0.00';
      return `<tr><td>${new Date(attempt.createdAt).toLocaleDateString()}</td><td>${escapeHtml(exam?.title || attempt.examId)}</td><td>${attempt.total}</td><td>${attempt.score}</td><td>${highest}</td><td>${pct}%</td></tr>`;
    }).join('');
    const totalExams = attempts.length;
    const avgPercent = attempts.length ? (attempts.reduce((sum, item) => sum + ((item.total ? item.score / item.total : 0) * 100), 0) / attempts.length).toFixed(2) : '0.00';
    return `<section class="result-card marksheet-onepage"><header class="result-card__head"><h1>MegaPrep Result Card</h1><p>Professional Academic Transcript</p></header><div class="result-card__meta"><div><strong>Student Name</strong><span>${escapeHtml(student.name)}</span></div><div><strong>Roll Number</strong><span>${escapeHtml(student.rollNumber || '')}</span></div><div><strong>Class</strong><span>${escapeHtml(student.className || '')}</span></div><div><strong>Institute</strong><span>${escapeHtml(student.institute || '')}</span></div><div><strong>Phone</strong><span>${escapeHtml(student.phone || '')}</span></div></div><div class="result-card__stats"><article><strong>${totalExams}</strong><span>Total Exams</span></article><article><strong>${avgPercent}%</strong><span>Average %</span></article></div><div class="table-wrap"><table><thead><tr><th>Date</th><th>Exam Name</th><th>Full Marks</th><th>Obtained Mark</th><th>Highest Mark</th><th>Percentage</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No exam result yet.</td></tr>'}</tbody></table></div></section>`;
  }

  function initStudentProfilePage() {
    const target = document.getElementById('studentProfilePage');
    const printBtn = document.getElementById('printStudentMarksheetBtn');
    if (!target || !printBtn) return;
    const params = new URLSearchParams(window.location.search);
    const studentId = params.get('studentId') || '';
    target.innerHTML = buildStudentProfileMarkup(studentId);
    printBtn.addEventListener('click', () => {
      const win = window.open('', '_blank', 'width=1000,height=800');
      if (!win) return showToast('Popup blocked by browser.', 'error');
      win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Marksheet</title><link rel="stylesheet" href="styles.css"></head><body>${buildStudentProfileMarkup(studentId)}</body></html>`);
      win.document.close();
      win.print();
    });
  }

  async function exportStudentsSheet(className = '') {
    const XLSX = await ensureXlsxLib();
    const rows = state.students
      .filter((student) => !className || (student.className || student.course || '') === className)
      .map((student) => ({
        roll_number: student.rollNumber || '',
        student_name: student.name || '',
        class: student.className || student.course || '',
        institute: student.institute || '',
        phone_number: student.phone || '',
      }));
    if (!rows.length) return showToast('No student found for export.', 'error');
    const sheet = XLSX.utils.json_to_sheet(rows);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, className || 'All Students');
    XLSX.writeFile(book, className ? `${className.replace(/\s+/g, '-').toLowerCase()}-students.xlsx` : 'all-students.xlsx');
  }

  function buildStudentProfileMarkup(studentId) {
    const student = state.students.find((item) => item.id === studentId);
    if (!student) return '<p class="muted-copy">Student not found.</p>';
    const attempts = state.attempts.filter((attempt) => attempt.studentId === studentId);
    const rows = attempts.map((attempt) => {
      const exam = findExam(attempt.examId);
      const highest = state.attempts
        .filter((item) => item.examId === attempt.examId)
        .reduce((max, item) => Math.max(max, Number(item.score || 0)), 0);
      const pct = attempt.total ? ((attempt.score / attempt.total) * 100).toFixed(2) : '0.00';
      return `<tr><td>${new Date(attempt.createdAt).toLocaleDateString()}</td><td>${escapeHtml(exam?.title || attempt.examId)}</td><td>${attempt.total}</td><td>${attempt.score}</td><td>${highest}</td><td>${pct}%</td></tr>`;
    }).join('');
    const totalExams = attempts.length;
    const avgPercent = attempts.length ? (attempts.reduce((sum, item) => sum + ((item.total ? item.score / item.total : 0) * 100), 0) / attempts.length).toFixed(2) : '0.00';
    return `<section class="result-card marksheet-onepage"><header class="result-card__head"><h1>MegaPrep Result Card</h1><p>Academic Transcript</p></header><div class="result-card__meta"><div><strong>Student Name</strong><span>${escapeHtml(student.name)}</span></div><div><strong>Roll Number</strong><span>${escapeHtml(student.rollNumber || '')}</span></div><div><strong>Class</strong><span>${escapeHtml(student.className || '')}</span></div><div><strong>Institute</strong><span>${escapeHtml(student.institute || '')}</span></div><div><strong>Phone</strong><span>${escapeHtml(student.phone || '')}</span></div></div><div class="result-card__stats"><article><strong>${totalExams}</strong><span>Total Exams</span></article><article><strong>${avgPercent}%</strong><span>Average %</span></article></div><div class="table-wrap"><table class="result-table"><thead><tr><th>Date</th><th>Exam Name</th><th>Full Marks</th><th>Obtained Mark</th><th>Highest Mark</th><th>Percentage</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No exam result yet.</td></tr>'}</tbody></table></div></section>`;
  }

  function initStudentProfilePage() {
    const target = document.getElementById('studentProfilePage');
    const printBtn = document.getElementById('printStudentMarksheetBtn');
    if (!target || !printBtn) return;
    const params = new URLSearchParams(window.location.search);
    const studentId = params.get('studentId') || '';
    target.innerHTML = buildStudentProfileMarkup(studentId);
    printBtn.addEventListener('click', async () => {
      const win = window.open('', '_blank', 'width=1000,height=800');
      if (!win) return showToast('Popup blocked by browser.', 'error');
      let cssText = '';
      try {
        cssText = await fetch('styles.css').then((res) => res.text());
      } catch {
        cssText = '';
      }
      win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Marksheet</title><style>${cssText}</style></head><body>${buildStudentProfileMarkup(studentId)}</body></html>`);
      win.document.close();
      win.print();
    });
  }

  async function exportStudentsSheet(className = '') {
    const XLSX = await ensureXlsxLib();
    const rows = state.students
      .filter((student) => !className || (student.className || student.course || '') === className)
      .map((student) => ({
        roll_number: student.rollNumber || '',
        student_name: student.name || '',
        class: student.className || student.course || '',
        institute: student.institute || '',
        phone_number: student.phone || '',
      }));
    if (!rows.length) return showToast('No student found for export.', 'error');
    const sheet = XLSX.utils.json_to_sheet(rows);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, className || 'All Students');
    XLSX.writeFile(book, className ? `${className.replace(/\s+/g, '-').toLowerCase()}-students.xlsx` : 'all-students.xlsx');
  }

  function buildStudentProfileMarkup(studentId) {
    const student = state.students.find((item) => item.id === studentId);
    if (!student) return '<p class="muted-copy">Student not found.</p>';
    const attempts = state.attempts.filter((attempt) => attempt.studentId === studentId);
    const rows = attempts.map((attempt) => {
      const exam = findExam(attempt.examId);
      const highest = state.attempts
        .filter((item) => item.examId === attempt.examId)
        .reduce((max, item) => Math.max(max, Number(item.score || 0)), 0);
      const pct = attempt.total ? ((attempt.score / attempt.total) * 100).toFixed(2) : '0.00';
      return `<tr><td>${new Date(attempt.createdAt).toLocaleDateString()}</td><td>${escapeHtml(exam?.title || attempt.examId)}</td><td>${attempt.total}</td><td>${attempt.score}</td><td>${highest}</td><td>${pct}%</td></tr>`;
    }).join('');
    const totalExams = attempts.length;
    const avgPercent = attempts.length ? (attempts.reduce((sum, item) => sum + ((item.total ? item.score / item.total : 0) * 100), 0) / attempts.length).toFixed(2) : '0.00';
    const latestOmr = attempts.find((attempt) => attempt.omrPreview);
    const latestBreakdown = latestOmr?.answerBreakdown || [];
    const breakdownMarkup = latestBreakdown.length
      ? `<div class="table-wrap"><table class="result-table"><thead><tr><th>Q. No</th><th>Correct</th><th>Student</th><th>Status</th></tr></thead><tbody>${latestBreakdown.map((item) => `<tr><td>${item.qno}</td><td>${item.correct}</td><td>${item.marked}</td><td>${item.status}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted-copy">No OMR answer breakdown available yet.</p>';
    const omrPreview = latestOmr?.omrPreview ? `<img src="${latestOmr.omrPreview}" alt="Latest OMR Scan" style="width:100%;max-height:280px;object-fit:contain;border:1px solid #cbd5e1;border-radius:10px;" />` : '<p class="muted-copy">No scanned OMR attached yet.</p>';
    return `<section class="result-card marksheet-onepage"><header class="result-card__head"><h1>MegaPrep Result Card</h1><p>Academic Transcript</p></header><div class="result-card__meta"><div><strong>Student Name</strong><span>${escapeHtml(student.name)}</span></div><div><strong>Roll Number</strong><span>${escapeHtml(student.rollNumber || '')}</span></div><div><strong>Class</strong><span>${escapeHtml(student.className || '')}</span></div><div><strong>Institute</strong><span>${escapeHtml(student.institute || '')}</span></div><div><strong>Phone</strong><span>${escapeHtml(student.phone || '')}</span></div></div><div class="result-card__stats"><article><strong>${totalExams}</strong><span>Total Exams</span></article><article><strong>${avgPercent}%</strong><span>Average %</span></article></div><div class="table-wrap"><table class="result-table"><thead><tr><th>Date</th><th>Exam Name</th><th>Full Marks</th><th>Obtained Mark</th><th>Highest Mark</th><th>Percentage</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No exam result yet.</td></tr>'}</tbody></table></div><h3>Latest Scanned OMR</h3>${omrPreview}<h3>Answer-wise Status</h3>${breakdownMarkup}</section>`;
  }

  function initStudentProfilePage() {
    const target = document.getElementById('studentProfilePage');
    const printBtn = document.getElementById('printStudentMarksheetBtn');
    if (!target || !printBtn) return;
    const params = new URLSearchParams(window.location.search);
    const studentId = params.get('studentId') || '';
    target.innerHTML = buildStudentProfileMarkup(studentId);
    printBtn.addEventListener('click', async () => {
      const win = window.open('', '_blank', 'width=1000,height=800');
      if (!win) return showToast('Popup blocked by browser.', 'error');
      let cssText = '';
      try {
        cssText = await fetch('styles.css').then((res) => res.text());
      } catch {
        cssText = '';
      }
      win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Marksheet</title><style>${cssText}</style></head><body>${buildStudentProfileMarkup(studentId)}</body></html>`);
      win.document.close();
      win.print();
    });
  }

  async function exportStudentsSheet(className = '') {
    const XLSX = await ensureXlsxLib();
    const rows = state.students
      .filter((student) => !className || (student.className || student.course || '') === className)
      .map((student) => ({
        roll_number: student.rollNumber || '',
        student_name: student.name || '',
        class: student.className || student.course || '',
        institute: student.institute || '',
        phone_number: student.phone || '',
      }));
    if (!rows.length) return showToast('No student found for export.', 'error');
    const sheet = XLSX.utils.json_to_sheet(rows);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, className || 'All Students');
    XLSX.writeFile(book, className ? `${className.replace(/\s+/g, '-').toLowerCase()}-students.xlsx` : 'all-students.xlsx');
  }

  function buildSolutionQuestionPaperMarkup(exam, attempt) {
    if (!exam || !attempt) return '<p class="muted-copy">Solution comparison unavailable.</p>';
    const variants = buildExamSetVariants(exam);
    const targetSet = variants.find((item) => String(item.setCode).toUpperCase() === String(attempt.omrSet || '').toUpperCase()) || variants[0];
    if (!targetSet) return '<p class="muted-copy">No set data found for this exam.</p>';
    const markedAnswers = attempt.studentAnswers || [];
    const questionsMarkup = targetSet.setQuestions.map((question, index) => {
      const displaySubject = question.subject || exam.subject || '';
      if (question.type !== 'mcq') {
        const subs = (question.subQuestions || []).map((item) => `<div><strong>${escapeHtml(item.label || '')}.</strong> ${formatMathForDisplay(item.prompt || '', { subject: displaySubject })}${item.answer ? `<div class="answer-block"><strong>Answer:</strong> ${formatExplanationForDisplay(item.answer, { subject: displaySubject })}</div>` : ''}</div>`).join('');
        const explanation = question.explanation ? `<p class="solution-legend"><strong>Explanation:</strong> ${formatExplanationForDisplay(question.explanation, { subject: displaySubject })}</p>` : '';
        return `<article class="print-question"><h3>${index + 1}. ${formatMathForDisplay(question.question || question.stimulus || '', { subject: displaySubject })}</h3>${subs || '<p class="muted-copy">CQ / written answer.</p>'}${explanation}</article>`;
      }
      const correct = targetSet.answerKey[index] || '-';
      const marked = markedAnswers[index] || '-';
      const options = (question.options || []).map((option, optionIndex) => {
        const label = String.fromCharCode(65 + optionIndex);
        const isMarked = label === marked;
        const isCorrect = label === correct;
        return `<li class="${isMarked ? 'is-marked' : ''} ${isCorrect ? 'is-correct' : ''}"><span class="option-label">${label}.</span> <span>${formatMathForDisplay(option, { subject: displaySubject })}</span></li>`;
      }).join('');
      const explanation = question.explanation ? `<p class="solution-legend"><strong>Explanation:</strong> ${formatExplanationForDisplay(question.explanation, { subject: displaySubject })}</p>` : '';
      return `<article class="print-question"><h3>${index + 1}. ${formatMathForDisplay(question.question || question.stimulus || '', { subject: displaySubject })}</h3><ul class="option-list option-list--grid">${options}</ul><p class="solution-legend"><strong>Marked:</strong> ${escapeHtml(marked)} · <strong>Correct:</strong> ${escapeHtml(correct)}</p>${explanation}</article>`;
    }).join('');
    return `<section class="paper live-preview-paper"><div class="board-head board-head--${escapeAttr(targetSet.config.headerTheme || 'classic')}"><h2>${formatMathForDisplay(exam.title)} · Solution Sheet</h2><div class="board-meta"><span><strong>Set:</strong> ${escapeHtml(targetSet.setLabel)}</span><span><strong>Student Marked vs Correct</strong></span></div></div><div class="question-grid">${questionsMarkup || '<p>No question found.</p>'}</div></section>`;
  }

  function buildStudentProfileMarkup(studentId, selectedAttemptIds = [], activeAttemptId = '', activeSolutionAttemptId = '') {
    const student = state.students.find((item) => item.id === studentId);
    if (!student) return '<p class="muted-copy">Student not found.</p>';
    const attempts = state.attempts
      .filter((attempt) => attempt.studentId === studentId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const selected = new Set(selectedAttemptIds);
    const detailAttempt = attempts.find((attempt) => attempt.id === activeAttemptId) || attempts[0] || null;
    const detailExam = detailAttempt ? findExam(detailAttempt.examId) : null;
    const detailBreakdown = detailAttempt?.answerBreakdown || [];
    const solutionAttempt = attempts.find((attempt) => attempt.id === activeSolutionAttemptId) || detailAttempt;
    const solutionExam = solutionAttempt ? findExam(solutionAttempt.examId) : null;
    const detailBreakdownMarkup = detailBreakdown.length
      ? `<div class="table-wrap"><table class="result-table"><thead><tr><th>Q. No</th><th>Correct</th><th>Student</th><th>Status</th></tr></thead><tbody>${detailBreakdown.map((item) => `<tr><td>${item.qno}</td><td>${item.correct}</td><td>${item.marked}</td><td>${item.status}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted-copy">এই exam-এর answer breakdown পাওয়া যায়নি।</p>';
    const detailOmr = detailAttempt?.omrPreview ? `<img src="${detailAttempt.omrPreview}" alt="OMR Preview" style="width:100%;max-height:260px;object-fit:contain;border:1px solid #cbd5e1;border-radius:10px;" />` : '<p class="muted-copy">No OMR image found for this exam.</p>';
    const examRows = attempts.map((attempt) => {
      const exam = findExam(attempt.examId);
      const pct = attempt.total ? ((attempt.score / attempt.total) * 100).toFixed(2) : '0.00';
      return `<tr><td><input type="checkbox" data-attempt-select="${attempt.id}" ${selected.has(attempt.id) ? 'checked' : ''} /></td><td><button type="button" class="toolbar-button" data-attempt-view="${attempt.id}">Details</button></td><td><button type="button" class="toolbar-button" data-attempt-solution="${attempt.id}">Solution Sheet</button></td><td>${escapeHtml(exam?.title || attempt.examId)}</td><td>${attempt.score}/${attempt.total}</td><td>${pct}%</td><td>${new Date(attempt.createdAt).toLocaleDateString()}</td></tr>`;
    }).join('');
    const solutionMarkup = solutionAttempt
      ? `<div class="solution-sheet-box"><h4>Solution Sheet (${escapeHtml(solutionAttempt.omrSet || 'Set ?')})</h4><p class="muted-copy"><strong>Exam:</strong> ${escapeHtml(solutionExam?.title || solutionAttempt.examId)}</p>${buildSolutionQuestionPaperMarkup(solutionExam, solutionAttempt)}</div>`
      : '<p class="muted-copy">Solution sheet পাওয়া যায়নি।</p>';
    return `<section class="result-card marksheet-onepage"><header class="result-card__head"><h1>Student Profile</h1><p>Exam List + Detailed Result View</p></header><div class="result-card__meta"><div><strong>Student Name</strong><span>${escapeHtml(student.name)}</span></div><div><strong>Roll Number</strong><span>${escapeHtml(student.rollNumber || '')}</span></div><div><strong>Class</strong><span>${escapeHtml(student.className || '')}</span></div><div><strong>Institute</strong><span>${escapeHtml(student.institute || '')}</span></div><div><strong>Phone</strong><span>${escapeHtml(student.phone || '')}</span></div></div><h3>Given Exams</h3><p class="muted-copy">যে exam গুলো marksheet এ রাখতে চান সেগুলো checkbox দিয়ে select করুন।</p><div class="table-wrap"><table class="result-table"><thead><tr><th>Select</th><th>Details</th><th>Solution Sheet</th><th>Exam</th><th>Score</th><th>Percent</th><th>Date</th></tr></thead><tbody>${examRows || '<tr><td colspan="7">No exam result yet.</td></tr>'}</tbody></table></div><h3>Selected Exam Details</h3>${detailAttempt ? `<p><strong>Exam:</strong> ${escapeHtml(detailExam?.title || detailAttempt.examId)} · <strong>Full Marks:</strong> ${detailAttempt.total} · <strong>Obtained:</strong> ${detailAttempt.score}</p><div class="student-detail-grid"><div>${detailOmr}<h4>Answer-wise Status</h4>${detailBreakdownMarkup}</div><div>${solutionMarkup}</div></div>` : '<p class="muted-copy">কোনো exam attempt পাওয়া যায়নি।</p>'}</section>`;
  }

  function buildSelectedMarksheetMarkup(studentId, selectedAttemptIds = []) {
    const student = state.students.find((item) => item.id === studentId);
    if (!student) return '<p>Student not found.</p>';
    const selectedSet = new Set(selectedAttemptIds);
    const selectedAttempts = state.attempts
      .filter((attempt) => attempt.studentId === studentId && selectedSet.has(attempt.id))
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const rows = selectedAttempts.map((attempt) => {
      const exam = findExam(attempt.examId);
      const highest = state.attempts
        .filter((item) => item.examId === attempt.examId)
        .reduce((max, item) => Math.max(max, Number(item.score || 0)), 0);
      const pct = attempt.total ? ((attempt.score / attempt.total) * 100).toFixed(2) : '0.00';
      return `<tr><td>${new Date(attempt.createdAt).toLocaleDateString()}</td><td>${escapeHtml(exam?.title || attempt.examId)}</td><td>${attempt.total}</td><td>${attempt.score}</td><td>${highest}</td><td>${pct}%</td></tr>`;
    }).join('');
    return `<section class="result-card marksheet-onepage"><header class="result-card__head"><h1>MegaPrep Result Card</h1><p>Selected Exam Marksheet</p></header><div class="result-card__meta"><div><strong>Student Name</strong><span>${escapeHtml(student.name)}</span></div><div><strong>Roll Number</strong><span>${escapeHtml(student.rollNumber || '')}</span></div><div><strong>Class</strong><span>${escapeHtml(student.className || '')}</span></div><div><strong>Institute</strong><span>${escapeHtml(student.institute || '')}</span></div><div><strong>Phone</strong><span>${escapeHtml(student.phone || '')}</span></div></div><div class="table-wrap"><table class="result-table"><thead><tr><th>Date</th><th>Exam Name</th><th>Full Marks</th><th>Obtained Mark</th><th>Highest Mark</th><th>Percentage</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No selected exam.</td></tr>'}</tbody></table></div></section>`;
  }

  function initStudentProfilePage() {
    const target = document.getElementById('studentProfilePage');
    const printBtn = document.getElementById('printStudentMarksheetBtn');
    if (!target || !printBtn) return;
    const studentId = new URLSearchParams(window.location.search).get('studentId') || '';
    const attempts = state.attempts.filter((attempt) => attempt.studentId === studentId);
    const selectedAttemptIds = new Set(attempts.map((attempt) => attempt.id));
    let activeAttemptId = attempts[0]?.id || '';
    let activeSolutionAttemptId = attempts[0]?.id || '';

    const render = () => {
      target.innerHTML = buildStudentProfileMarkup(studentId, [...selectedAttemptIds], activeAttemptId, activeSolutionAttemptId);
      target.querySelectorAll('[data-attempt-select]').forEach((checkbox) => checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedAttemptIds.add(checkbox.dataset.attemptSelect);
        else selectedAttemptIds.delete(checkbox.dataset.attemptSelect);
      }));
      target.querySelectorAll('[data-attempt-view]').forEach((button) => button.addEventListener('click', () => {
        activeAttemptId = button.dataset.attemptView || '';
        render();
      }));
      target.querySelectorAll('[data-attempt-solution]').forEach((button) => button.addEventListener('click', () => {
        activeSolutionAttemptId = button.dataset.attemptSolution || '';
        render();
      }));
    };

    render();
    printBtn.textContent = 'Print Selected Marksheet (PDF)';
    printBtn.addEventListener('click', async () => {
      if (!selectedAttemptIds.size) return showToast('At least one exam must be selected.', 'error');
      const win = window.open('', '_blank', 'width=1000,height=800');
      if (!win) return showToast('Popup blocked by browser.', 'error');
      let cssText = '';
      try {
        cssText = await fetch('styles.css').then((res) => res.text());
      } catch {
        cssText = '';
      }
      win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Selected Marksheet</title><style>${cssText}</style></head><body>${buildSelectedMarksheetMarkup(studentId, [...selectedAttemptIds])}</body></html>`);
      win.document.close();
      win.focus();
      win.print();
    });
  }

  function initAnalyticsPage() {
    document.getElementById('attemptForm').addEventListener('submit', saveAttempt);
    populateAttemptSelectors();
    renderAnalytics();
  }

  function populateAttemptSelectors() {
    const exam = document.getElementById('attemptExam');
    const student = document.getElementById('attemptStudent');
    if (!exam || !student) return;
    exam.innerHTML = state.exams.length ? state.exams.map((item) => `<option value="${item.id}">${escapeHtml(item.title)}</option>`).join('') : '<option value="">No exams</option>';
    student.innerHTML = state.students.length ? state.students.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('') : '<option value="">No students</option>';
  }

  function saveAttempt(event) {
    event.preventDefault();
    state.attempts.unshift({ id: uid('attempt'), examId: document.getElementById('attemptExam').value, studentId: document.getElementById('attemptStudent').value, score: Number(document.getElementById('attemptScore').value || 0), total: Number(document.getElementById('attemptTotal').value || 0), correctIds: parseCommaList(document.getElementById('attemptCorrectIds').value), incorrectIds: parseCommaList(document.getElementById('attemptIncorrectIds').value), createdAt: new Date().toISOString() });
    saveState();
    event.target.reset();
    populateAttemptSelectors();
    renderAnalytics();
    showToast('Attempt saved.');
  }

  function renderAnalytics() {
    const summary = document.getElementById('analyticsSummary');
    if (!summary) return;
    const average = state.attempts.length ? (state.attempts.reduce((sum, item) => sum + ((item.score / (item.total || 1)) * 100), 0) / state.attempts.length).toFixed(1) : '0.0';
    summary.innerHTML = `<article class="summary-card"><span>Exam Attempts</span><strong>${state.attempts.length}</strong></article><article class="summary-card"><span>Average Score</span><strong>${average}%</strong></article><article class="summary-card"><span>Questions</span><strong>${state.questions.length}</strong></article><article class="summary-card"><span>Students</span><strong>${state.students.length}</strong></article>`;
    if (!window.Chart) return;
    analyticsChart?.destroy(); accuracyChart?.destroy();
    analyticsChart = new Chart(document.getElementById('analyticsChart'), { type: 'bar', data: { labels: ['MCQ Exams', 'CQ Exams', 'Published', 'Draft'], datasets: [{ label: 'Exams', data: [state.exams.filter((e) => e.examType === 'MCQ').length, state.exams.filter((e) => e.examType === 'CQ').length, state.exams.filter((e) => e.published).length, state.exams.filter((e) => !e.published).length], backgroundColor: ['#4f89ff', '#13b6aa', '#22b55f', '#94a3b8'] }] }, options: { responsive: true, maintainAspectRatio: false } });
    const accuracy = {};
    state.attempts.forEach((attempt) => { attempt.correctIds.forEach((id) => { accuracy[id] = accuracy[id] || { correct: 0, total: 0 }; accuracy[id].correct += 1; accuracy[id].total += 1; }); attempt.incorrectIds.forEach((id) => { accuracy[id] = accuracy[id] || { correct: 0, total: 0 }; accuracy[id].total += 1; }); });
    const labels = Object.keys(accuracy).slice(0, 6);
    accuracyChart = new Chart(document.getElementById('accuracyChart'), { type: 'line', data: { labels: labels.length ? labels : ['No data'], datasets: [{ label: 'Accuracy %', data: labels.length ? labels.map((id) => Math.round((accuracy[id].correct / accuracy[id].total) * 100)) : [0], borderColor: '#7c3aed', backgroundColor: 'rgba(124,58,237,0.15)', tension: 0.35, fill: true }] }, options: { responsive: true, maintainAspectRatio: false } });
  }

  function initDevicesPage() { renderDevices(); }
  function renderDevices() {
    const target = document.getElementById('deviceList');
    if (!target) return;
    if (!state.devices.length) return target.innerHTML = emptyState('No session devices recorded.');
    const session = getSession();
    target.innerHTML = state.devices.map((device) => `<article class="entity-card"><div><h4>${escapeHtml(device.label)}</h4><p>${escapeHtml(device.role || 'guest')} · ${new Date(device.lastActive).toLocaleString()}</p></div><button class="toolbar-button ${session?.deviceId === device.id ? 'toolbar-button--danger' : ''}" data-force-device="${device.id}">Force Logout</button></article>`).join('');
    target.querySelectorAll('[data-force-device]').forEach((button) => button.addEventListener('click', () => { state.devices = state.devices.filter((item) => item.id !== button.dataset.forceDevice); if (getSession()?.deviceId === button.dataset.forceDevice) localStorage.removeItem(SESSION_KEY); saveState(); renderDevices(); showToast('Device removed.'); }));
  }

  function initPasswordsPage() {
    document.getElementById('passwordForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const current = document.getElementById('currentPassword').value;
      const next = document.getElementById('newPassword').value;
      const confirm = document.getElementById('confirmPassword').value;
      if (!next || next !== confirm) return showToast('Password confirmation failed.', 'error');
      try {
        await cloudflareRequest('/auth/change-password', {
          method: 'POST',
          body: { current_password: current, new_password: next },
        });
        event.target.reset();
        showToast('Password updated.');
      } catch (error) {
        showToast(error?.message || 'Password update failed.', 'error');
      }
    });
  }

  function parseCommaList(value) { return value.split(',').map((item) => item.trim()).filter(Boolean); }
  function parseCSVRows(text) { const lines = text.trim().split(/\r?\n/).filter(Boolean); if (!lines.length) return []; const header = lines[0].split(',').map((item) => item.trim()); return lines.slice(1).map((line) => { const values = line.split(',').map((item) => item.trim()); return Object.fromEntries(header.map((key, index) => [key, values[index] || ''])); }); }
  function upsert(collection, item) { const index = collection.findIndex((entry) => entry.id === item.id); if (index === -1) collection.unshift(item); else collection[index] = { ...collection[index], ...item }; }
  function readFileAsDataUrl(file) { if (!file) return Promise.resolve(''); return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); }); }
  const katexDelimiters = [
    { left: '$$', right: '$$', display: true },
    { left: '$', right: '$', display: false },
  ];

  function renderKatexInElement(target) {
    if (!target || !window.renderMathInElement) return;
    window.renderMathInElement(target, {
      delimiters: katexDelimiters,
      throwOnError: false,
      strict: 'ignore',
    });
  }

  function queueTypeset() {
    if (window.renderMathInElement) {
      renderKatexInElement(document.body);
      return;
    }
    if (window.MathJax?.typesetPromise) window.MathJax.typesetPromise();
  }
  function formatExplanationForDisplay(text, options = {}) {
    const normalized = String(text || '')
      .replace(/\\n/g, '\n')
      .replace(/\s+(\d+[.)])\s+/g, '\n$1 ')
      .replace(/\s+[•●]\s+/g, '\n• ');
    return normalized
      .split(/\r?\n/)
      .map((line) => formatMathForDisplay(line, options))
      .filter((line) => line.trim().length > 0)
      .join('<br />');
  }
  function hasLatexSyntax(text = '') {
    return /\\[a-zA-Z]+|\$\$|\$[^$]+\$/.test(String(text || ''));
  }

  function hasMathDelimiter(text = '') {
    return /\$\$|\$[^$]+\$/.test(String(text || ''));
  }

  function normalizeLatexForRender(text = '') {
    let next = String(text || '');
    // handle over-escaped command backslashes from API payloads
    next = next.replace(/\\\\([a-zA-Z])/g, '\\$1');
    // normalize classic delimiters to dollar-style for consistency
    next = next
      .replace(/\\\[((?:\\.|[\s\S])*?)\\\]/g, '$$$1$$')
      .replace(/\\\(((?:\\.|[\s\S])*?)\\\)/g, '$$$1$');
    // normalize malformed bracket-style delimiters like [\hat{i}\]
    next = next
      .replace(/\[(\\[\s\S]*?)\\\]/g, '$$$1$')
      .replace(/\[([A-Za-z0-9^_+\-*/=().,:| ]+?)\\\]/g, '$$$1$');
    // normalize duplicated dollar markers introduced by messy AI output
    next = next
      .replace(/\$\$\$/g, '$$')
      .replace(/\$\s+\$/g, '');
    // if LaTeX commands exist but no delimiters, wrap inline
    if (!hasMathDelimiter(next) && /\\[a-zA-Z]+/.test(next)) {
      next = `$${next}$`;
    }
    return next;
  }

  function wrapMathJaxInline(text = '') {
    const cleaned = String(text || '')
      .trim()
      .replace(/^\$\$(.*)\$\$$/s, '$1')
      .replace(/^\$(.*)\$$/s, '$1')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<span class="math-tex">$${cleaned}$</span>`;
  }

  function formatMathForDisplay(text, options = {}) {
    const raw = String(text || '');
    const latexReady = normalizeLatexForRender(raw);
    if (hasLatexSyntax(latexReady)) {
      return escapeHtml(latexReady).replace(/\n/g, '<br />');
    }
    const subject = String(options.subject || '').toLowerCase();
    const isPhysics = subject.includes('physics') || subject.includes('পদার্থ');
    const normalized = escapeHtml(latexToPlainText(raw))
      .replace(/\s*\|\s*$/g, '')
      .replace(/\*/g, isPhysics ? ' * ' : ' × ')
      .replace(/\s*=\s*/g, ' = ')
      .replace(/([0-9০-৯]+)\s*\^(?=\s*$)/g, '$1°')
      .replace(/\b(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?|10)\b/g, '$1 × $2')
      .replace(/\s+/g, ' ')
      .replace(isPhysics ? /([NnJjMmKkGgSsTtLl])(\d+)(?=[A-Za-z\]\s]|$)/g : /\b([a-zA-Z])(\d+)\b/g, '$1^$2')
      .trim();
    const withDiffFractions = isPhysics
      ? normalized
      : normalized
        .replace(/\bd\^([+\-−]?\d+(?:\.\d+)?)\s*([A-Za-z])\s*\/\s*d([A-Za-z])\^([+\-−]?\d+(?:\.\d+)?)\b/g, '<span class="math-frac"><span class="math-frac__num">d^$1$2</span><span class="math-frac__den">d$3^$4</span></span>')
        .replace(/\bd\s*([A-Za-z])\s*\/\s*d([A-Za-z])\b/g, '<span class="math-frac"><span class="math-frac__num">d$1</span><span class="math-frac__den">d$2</span></span>');
    const withSuperSub = withDiffFractions
      .replace(/sqrt\(([^)]+)\)/g, '√$1')
      .replace(/([A-Za-z0-9)\]])\s*\^\s*\(([^)]+)\)/g, '$1<sup>$2</sup>')
      .replace(/([A-Za-z0-9)\]])\s*_\s*\(([^)]+)\)/g, '$1<sub>$2</sub>')
      .replace(/([A-Za-z0-9)\]])\s*\^\s*([+\-−]?\d+(?:\.\d+)?)(?![A-Za-z])/g, '$1<sup>$2</sup>')
      .replace(/([A-Za-z0-9)\]])\s*\^\s*([A-Za-z])(?![A-Za-z0-9])/g, '$1<sup>$2</sup>')
      .replace(/([A-Za-z0-9)\]])\s*_\s*([A-Za-z0-9.]+)/g, '$1<sub>$2</sub>');
    if (isPhysics) return withSuperSub;
    return withSuperSub
      .replace(/\(([^()]+)\)\s*\/\s*\(([^()]+)\)/g, '<span class="math-frac"><span class="math-frac__num">$1</span><span class="math-frac__den">$2</span></span>')
      .replace(/(?<![\w>])([A-Za-z0-9.+\-]+)\s*\/\s*([A-Za-z0-9.+\-]+)(?![\w<])/g, '<span class="math-frac"><span class="math-frac__num">$1</span><span class="math-frac__den">$2</span></span>');
  }
  function emptyState(message) { return `<div class="empty-state"><p>${escapeHtml(message)}</p></div>`; }
  function escapeHtml(value = '') { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function escapeAttr(value = '') { return escapeHtml(value); }
})();
