/** DSH plugin detail page. Keep the client loadable without a build step. */
window.__ModuleLoader__.load({
  id: 'dsh-wechatbot',
  factory(require) {
    const React = require('react')
    const { createElement: h, useEffect, useRef, useState } = React
    const zh = navigator.language.toLowerCase().startsWith('zh')
    const t = (chinese, english) => zh ? chinese : english
    const P = 'dshwb-'
    const api = '/dsh-wechatbot/api'

    async function request(path, { body, signal } = {}) {
      const response = await fetch(api + path, {
        signal,
        cache: 'no-store',
        ...(body === undefined ? {} : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      })
      const type = response.headers.get('content-type') || ''
      if (response.ok && type.startsWith('image/')) return response.blob()
      const data = type.includes('application/json') ? await response.json() : null
      if (response.ok && data && data.ok !== false) return data
      if (response.status === 404 && !data?.error) {
        throw new Error(t('插件接口未加载，请确认插件已启用。', 'The panel API is unavailable. Check that the plugin is enabled.'))
      }
      throw new Error(data?.error || t('请求失败（' + response.status + '）', 'Request failed (' + response.status + ')'))
    }

    const css = `
      [data-dsh-wechatbot] {
        --wb-fg: var(--dsw-alias-label-primary, #24272d);
        --wb-muted: var(--dsw-alias-label-secondary, #646b78);
        --wb-border: var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2, #dce0e7));
        --wb-surface: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1, #fff));
        --wb-bg: var(--dsw-alias-bg-base, #f6f7fa);
        --wb-brand: var(--dsw-alias-brand-primary, #3158ce);
        --wb-control: var(--dsw-alias-bg-layer-1, #fff);
        --wb-hover: var(--dsw-alias-interactive-bg-hover, #f6f7fa);
        --wb-danger: var(--dsw-alias-state-error-primary, #b43038);
        color: var(--wb-fg);
        font-size: 14px;
        line-height: 1.55;
        width: 100%;
        max-width: 1120px;
        margin: 0 auto;
        padding: 2px 0 12px;
      }
      [data-dsh-wechatbot] * { box-sizing: border-box; }
      [data-dsh-wechatbot] h2, [data-dsh-wechatbot] h3, [data-dsh-wechatbot] p, [data-dsh-wechatbot] dl { margin: 0; }
      [data-dsh-wechatbot] h2 { font-size: 22px; line-height: 1.3; font-weight: 650; }
      [data-dsh-wechatbot] h3 { font-size: 15px; font-weight: 650; }
      .dshwb-muted { color: var(--wb-muted); font-size: 13px; overflow-wrap: anywhere; }
      .dshwb-head, .dshwb-toolbar, .dshwb-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .dshwb-head, .dshwb-toolbar { justify-content: space-between; }
      .dshwb-head { gap: 16px; margin-bottom: 16px; }
      .dshwb-heading { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; }
      .dshwb-status { border: 1px solid var(--wb-border); border-radius: 999px; font-size: 12px; padding: 2px 9px; }
      .dshwb-status::before { content: ""; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; display: inline-block; vertical-align: 2px; background: var(--wb-muted); }
      .dshwb-status[data-running="true"]::before, .dshwb-status[data-connection="true"]::before, .dshwb-status[data-ready="true"]::before { background: #258450; }
      .dshwb-status[data-connection="false"]::before { background: var(--wb-danger); }
      .dshwb-status[data-connection="true"] { color: var(--dsw-alias-state-success-primary, #237447); }
      .dshwb-status[data-connection="false"] { color: var(--wb-danger); }
      .dshwb-nav { display: flex; flex-wrap: wrap; gap: 18px; border-bottom: 1px solid var(--wb-border); margin-bottom: 16px; }
      .dshwb-nav button { appearance: none; border: 0; border-bottom: 2px solid transparent; border-radius: 4px 4px 0 0; padding: 8px 2px; background: transparent; color: var(--wb-muted); font: inherit; cursor: pointer; }
      .dshwb-nav button[aria-pressed="true"] { color: var(--wb-fg); border-bottom-color: var(--wb-brand); font-weight: 650; }
      .dshwb-btn { min-height: 34px; padding: 5px 12px; color: var(--wb-fg); border: 1px solid var(--wb-border); border-radius: 8px; background: var(--wb-control); font: inherit; font-size: 13px; cursor: pointer; }
      .dshwb-btn:hover:not(:disabled) { background: var(--wb-hover); }
      .dshwb-btn[data-tone="primary"] { background: var(--dsw-alias-button-primary-fill, var(--wb-brand)); border-color: transparent; color: var(--dsw-alias-label-primary-foreground, #fff); }
      .dshwb-btn[data-tone="primary"]:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--wb-brand)); }
      .dshwb-btn[data-tone="danger"] { color: var(--wb-danger); }
      .dshwb-btn:disabled { opacity: .55; cursor: default; }
      [data-dsh-wechatbot] :focus-visible { outline: 2px solid var(--wb-brand); outline-offset: 2px; }
      .dshwb-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; align-items: start; }
      .dshwb-chat-config { grid-column: 1 / -1; }
      .dshwb-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
      .dshwb-metrics > div { padding: 8px; border-radius: 8px; background: var(--wb-bg); }
      .dshwb-metrics dt { color: var(--wb-muted); font-size: 12px; }
      .dshwb-metrics dd { margin: 0; font-size: 20px; font-weight: 650; }
      .dshwb-send-item, .dshwb-setting-block { border-top: 1px solid var(--wb-border); padding-top: 10px; overflow-wrap: anywhere; }
      .dshwb-send-item img { width: 54px; border-radius: 6px; }
      .dshwb-send-item time { color: var(--wb-muted); font-size: 12px; }
      .dshwb-card .dshwb-send-item .dshwb-toolbar { margin-bottom: 3px; }
      .dshwb-card h4 { margin: 0; font-size: 13px; }
      .dshwb-setting-block, .dshwb-target-name { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
      .dshwb-setting-block { align-items: flex-start; flex-direction: column; }
      .dshwb-candidate-list { max-height: 190px; overflow: auto; }
      .dshwb-settings-layout { display: grid; align-items: start; grid-template-columns: minmax(105px, 145px) minmax(0, 1fr); gap: 16px; }
      .dshwb-settings-nav { display: grid; gap: 6px; }
      .dshwb-settings-nav button { text-align: left; }
      .dshwb-btn[aria-pressed="true"] { border-color: var(--wb-brand); }
      .dshwb-sticker-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(205px, 100%), 1fr)); gap: 12px; }
      .dshwb-sticker-cell { min-width: 0; padding: 10px; border: 1px solid var(--wb-border); border-radius: 8px; }
      .dshwb-sticker-cell img { display: block; max-width: 100%; width: 80px; border-radius: 6px; margin-bottom: 6px; }
      .dshwb-sticker-cell input, .dshwb-sticker-cell textarea, .dshwb-target-candidates input:not([type="checkbox"]) { max-width: 100%; }
      .dshwb-stack { display: grid; gap: 14px; min-width: 0; }
      .dshwb-card { background: var(--wb-surface); border: 1px solid var(--wb-border); border-radius: 12px; padding: 16px; min-width: 0; }
      .dshwb-card h3 + p { margin-top: 4px; }
      .dshwb-card .dshwb-toolbar { margin-bottom: 12px; }
      .dshwb-frame { display: grid; place-items: center; border: 1px solid var(--wb-border); border-radius: 8px; min-height: 160px; background: var(--wb-bg); margin: 12px 0 8px; overflow: hidden; }
      .dshwb-frame img { display: block; width: 100%; max-height: 430px; object-fit: contain; }
      .dshwb-detail { display: grid; grid-template-columns: minmax(84px, 1fr) minmax(0, 1.5fr); gap: 9px 12px; margin: 12px 0 !important; align-items: baseline; }
      .dshwb-detail dt { color: var(--wb-muted); font-size: 13px; }
      .dshwb-detail dd { margin: 0; overflow-wrap: anywhere; }
      .dshwb-banner { padding: 9px 12px; margin-bottom: 12px; border: 1px solid var(--wb-border); border-radius: 8px; }
      .dshwb-error { color: var(--wb-danger); overflow-wrap: anywhere; }
      .dshwb-list { display: grid; gap: 0; }
      .dshwb-list-row { padding: 9px 0; border-bottom: 1px solid var(--wb-border); display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; overflow-wrap: anywhere; }
      .dshwb-list-row:last-child { border-bottom: 0; }
      .dshwb-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: 14px 18px; margin-top: 13px; }
      .dshwb-field { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; min-width: 0; }
      .dshwb-field-wide { grid-column: 1 / -1; }
      .dshwb-field label { font-weight: 575; }
      [data-dsh-wechatbot] :is(input:not([type="checkbox"], [type="file"]), textarea, select) {
        background: var(--wb-control); border: 1px solid var(--wb-border); border-radius: 8px;
        color: var(--wb-fg); padding: 5px 10px; min-height: 34px; max-width: 100%; font: inherit; font-size: 13px;
      }
      .dshwb-field input:not([type="checkbox"], [type="file"]), .dshwb-field textarea, .dshwb-field select { width: 100%; }
      [data-dsh-wechatbot] textarea { resize: vertical; }
      .dshwb-workspace-link { background: none; color: var(--wb-brand); border: 0; padding: 0; text-decoration: underline; cursor: pointer; font: inherit; font-size: 13px; text-align: left; overflow-wrap: anywhere; width: fit-content; max-width: 100%; }
      .dshwb-workspace-link:disabled { opacity: .55; cursor: default; }
      .dshwb-document { border-top: 1px solid var(--wb-border); padding-top: 10px; }
      .dshwb-document-preview { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 300px; overflow: auto; color: var(--wb-fg); background: var(--wb-bg); border: 1px solid var(--wb-border); border-radius: 8px; padding: 12px; margin: 8px 0 0; font-size: 13px; }
      .dshwb-document .dshwb-list-row { border: 0; padding: 0; }
      .dshwb-field input[type="checkbox"] { accent-color: var(--wb-brand); width: 16px; height: 16px; margin: 0; }
      .dshwb-switch { display: flex; align-items: center; gap: 8px; min-height: 28px; }
      .dshwb-settings fieldset { margin: 0; min-width: 0; }
      .dshwb-settings .dshwb-delay { border: 0; padding: 0; }
      .dshwb-settings fieldset:disabled { opacity: .72; }
      .dshwb-settings summary { cursor: pointer; font-weight: 650; }
      .dshwb-save { position: sticky; bottom: 0; z-index: 1; background: var(--wb-surface); border-top: 1px solid var(--wb-border); padding: 10px 0 2px; }
      @media (max-width: 720px) {
        .dshwb-grid, .dshwb-fields, .dshwb-settings-layout { grid-template-columns: minmax(0, 1fr); }
        .dshwb-settings-nav { display: flex; flex-wrap: wrap; }
        .dshwb-delay .dshwb-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
    `

    const cls = (name) => P + name.split(' ').join(' ' + P)
    const title = (text) => h('h3', null, text)
    const hint = (text) => h('p', { className: cls('muted') }, text)
    const actions = (...children) => h('div', { className: cls('actions') }, ...children)
    const button = (text, onClick, opts = {}) => h('button', {
      key: opts.key, type: opts.type || 'button', className: cls('btn'), onClick, disabled: opts.disabled,
      'data-tone': opts.tone, 'aria-pressed': opts.pressed,
    }, text)

    function Preview({ connected, target, captureProtected, windowCaptureProtected, canEdit, busy, onToggleCaptureProtected }) {
      const targetId = target?.id
      const isClawbot = target?.mode === 'clawbot'
      const [shot, setShot] = useState(null)
      const [live, setLive] = useState(false)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')
      const controller = useRef(null)
      const url = useRef(null)

      const capture = async () => {
        if (controller.current || document.hidden || connected !== true || captureProtected || isClawbot) return false
        const active = new AbortController()
        controller.current = active
        setLoading(true)
        setError('')
        try {
          const image = await request('/screenshot', { body: { targetId }, signal: active.signal })
          if (active.signal.aborted) return false
          if (url.current) URL.revokeObjectURL(url.current)
          url.current = URL.createObjectURL(image)
          setShot(url.current)
          return true
        } catch (failure) {
          if (!active.signal.aborted) setError(failure.message)
          return false
        } finally {
          if (controller.current === active) {
            controller.current = null
            setLoading(false)
          }
        }
      }

      useEffect(() => {
        if (!captureProtected) return
        setLive(false)
        setError('')
        controller.current?.abort()
      }, [captureProtected])

      useEffect(() => {
        const hide = () => {
          if (!document.hidden) return
          setLive(false)
          controller.current?.abort()
        }
        document.addEventListener('visibilitychange', hide)
        return () => {
          document.removeEventListener('visibilitychange', hide)
          controller.current?.abort()
          if (url.current) URL.revokeObjectURL(url.current)
        }
      }, [])

      useEffect(() => {
        if (!live || connected !== true || captureProtected || isClawbot) return
        let active = true
        let timer
        const refresh = async () => {
          const ok = await capture()
          if (!active) return
          if (ok) timer = window.setTimeout(refresh, 5000)
          else setLive(false)
        }
        refresh()
        return () => {
          active = false
          window.clearTimeout(timer)
          controller.current?.abort()
        }
      }, [live, connected, captureProtected, isClawbot])

      const connection = connected === null ? t('状态未知', 'Status unknown')
        : connected ? t('已连接', 'Connected') : t('未连接', 'Disconnected')
      return h('section', { className: cls('card') },
        h('div', { className: cls('toolbar') }, title(t('微信窗口预览', 'WeChat window preview')),
          actions(
            h('label', { className: cls('switch') },
              h('input', {
                type: 'checkbox',
                checked: Boolean(captureProtected),
                disabled: busy || !canEdit,
                onChange: (event) => onToggleCaptureProtected?.(event.target.checked),
              }),
              t('防截屏模式', 'Capture-protected mode')),
            h('span', { className: cls('status'), 'data-connection': String(connected) }, connection))),
        windowCaptureProtected && !captureProtected && h('p', { className: cls('error'), role: 'status' },
          t('检测到微信窗口开启了系统防截屏保护，建议勾选上方「防截屏模式」以跳过截图与输入框 OCR 校验。',
            'WeChat screen-capture protection detected. Enable Capture-protected mode above to bypass screenshot and OCR checks.')),
        h('div', { className: cls('frame'), 'aria-busy': loading },
          isClawbot
            ? hint(t(`当前选中「${target.name}」为微信官方私聊通道（ClawBot），消息与图片通过后台加密通道直连收发，无需打开桌面微信窗口。`,
              `Selected "${target.name}" is an official WeChat ClawBot channel. Messages and images transfer directly without a desktop WeChat window.`))
            : captureProtected
              ? hint(t('已开启防截屏模式：已跳过窗口截图、OCR 与输入框图像核对，使用独立窗口标题校验与无像素收发。',
                'Capture-protected mode active: window screenshots, OCR, and composer image checks are bypassed.'))
              : shot ? h('img', { src: shot, alt: t('微信聊天窗口截图', 'WeChat chat window') })
                : hint(loading ? t('正在截取…', 'Capturing…') : t('暂无预览', 'No preview'))),
        actions(
          button(t('截取一张', 'Capture once'), capture, { disabled: !connected || captureProtected || isClawbot || live || loading || busy }),
          button(live ? t('暂停实时预览', 'Pause live preview') : t('开启实时预览', 'Start live preview'),
            () => setLive(!live), { disabled: !connected || captureProtected || isClawbot || busy || (loading && !live), pressed: live, tone: 'primary' })),
        error && h('p', { className: cls('error'), role: 'alert' }, error))
    }

    const field = (key, label, type = 'text', options = {}) => ({ key, label, type, ...options })
    const groups = [
      { id: 'sources', label: t('消息来源', 'Message sources'), fields: [
        field('trigger.onNotification', t('监测系统通知', 'Watch system notifications'), 'boolean'),
        field('dragCopyEnabled', t('拖拽复制微信信息', 'Read by drag-copy'), 'boolean'),
        ...[['x1', '起点 X'], ['y1', '起点 Y'], ['x2', '终点 X'], ['y2', '终点 Y']]
          .map(([key, label]) => field('dragPoints.' + key, t(label, key.toUpperCase()), 'number')),
        field('ocrEnabled', t('OCR 读屏', 'Read the screen with OCR'), 'boolean'),
        field('scan.enabled', t('启用定时巡检', 'Enable scheduled scans'), 'boolean'),
        field('scan.intervalMinutes', t('巡检间隔（分钟）', 'Scan interval (minutes)'), 'number', { min: 1, max: 120 }),
        field('attachScreenshot', t('使用模型视觉识别', 'Use model vision'), 'boolean'),
        field('screenshotMaxWidth', t('截图最大宽度（px）', 'Max screenshot width (px)'), 'number', { min: 320, max: 1600 }),
      ] },
      { id: 'reply', label: t('回复规则', 'Reply rules'), fields: [
        field('atKeywords', t('召唤关键词', 'Mention keywords'), 'list'),
        field('proactiveReplyProbability', t('群聊主动接话概率（%）', 'Proactive group reply chance (%)'), 'percent', { min: 0, max: 100 }),
        field('replyCooldownSeconds', t('群聊回复冷却（秒）', 'Group reply cooldown (seconds)'), 'number', { min: 0, max: 600 }),
        field('dailyProactiveLimit', t('每日发言上限', 'Daily send limit'), 'number', { min: 0, max: 10000, help: t('所有聊天的发送共用额度，0 表示不限。', 'Shared by all chats. 0 means unlimited.') }),
        field('maxMessageChars', t('单条消息字数上限', 'Max characters per message'), 'number', { min: 20, max: 2000 }),
        field('maxMessagesPerCall', t('连发信息次数上限', 'Max messages per batch'), 'number', { min: 1, max: 20 }),
        field('replyDelayMinSeconds', t('最小值', 'Minimum'), 'number', { min: 0, max: 10, step: 0.1 }),
        field('replyDelayMaxSeconds', t('最大值', 'Maximum'), 'number', { min: 0, max: 30, step: 0.1 }),
      ] },
      { id: 'persona', label: t('人格配置', 'Persona files'), fields: [] },
      { id: 'stickers', label: t('表情管理', 'Stickers'), fields: [] },
      { id: 'advanced', label: t('高级设置', 'Advanced'), fields: [
        field('reuseWindowMinutes', t('会话复用窗口（分钟）', 'Session reuse window (minutes)'), 'number', { min: 1, max: 60 }),
        field('archiveAfterMinutes', t('静默归档时间（分钟）', 'Archive after inactivity (minutes)'), 'number', { min: 1, max: 120 }),
        field('maxTurnsPerSession', t('单次会话最大轮次', 'Max turns per session'), 'number', {
          min: 0,
          max: 500,
          help: t('达到该轮次后自动归档并开启新会话，防止长对话人设遗忘（0 表示不限）。', 'Archive and rotate session after N turns to prevent persona drift (0 = unlimited).'),
        }),
        field('memoryMaxEntries', t('摘要保留条数', 'Summary entries retained'), 'number', { min: 5, max: 500 }),
        field('includeSessionMemory', t('跨会话记忆', 'Cross-session memory'), 'boolean'),
        field('memoryPromptEntries', t('注入记忆条数', 'Memory entries per prompt'), 'number', { min: 0, max: 20 }),
        field('workspaceTitle', t('工作区名', 'Workspace name')),
        field('antiDetection.enabled', t('启用防检测拟人化', 'Enable anti-detection humanization'), 'boolean'),
        field('antiDetection.phraseTyping', t('模拟词组打字输入', 'Phrase-chunked typing'), 'boolean', {
          help: t('短句按 1~4 字词组节奏逐段输入，避免 100% 剪贴板粘贴特征；长段或链接自动粘贴。', 'Type short lines in 1-4 char phrase chunks instead of clipboard paste.'),
        }),
        field('antiDetection.curvedMouse', t('曲线轨迹与随机靶点', 'Curved mouse & Gaussian click jitter'), 'boolean', {
          help: t('沿贝塞尔加减速曲线移动鼠标，高斯随机采样输入框点击点，连发不重复点击输入框。', 'Use cubic Bézier motion, Gaussian click jitter, and skip redundant clicks.'),
        }),
        field('antiDetection.naturalCadence', t('字数关联拟人停顿', 'Length-aware log-normal cadence'), 'boolean', {
          help: t('根据字数与对数正态分布动态计算构思及连发气泡间隔。', 'Scale composing and inter-bubble pauses with text length.'),
        }),
        field('antiDetection.minimalTouch', t('最小化窗口触碰', 'Minimize window touches'), 'boolean', {
          help: t('通知已有完整正文时不唤醒微信窗口，目标已在前台时不重复置顶。', 'Avoid touching WeChat windows on wake unless screen read is needed.'),
        }),
      ] },
    ]

    const settingsValue = (settings, key) => key.split('.').reduce((value, part) => value?.[part], settings)
    function displayValue(value, type) {
      if (type === 'list') return (value || []).join('\n')
      if (type === 'percent') return Number(((value ?? 0) * 100).toFixed(4))
      return value ?? ''
    }

    function parseValue(value, type) {
      if (type === 'list') return [...new Set(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))]
      if (type === 'percent') return Number(value) / 100
      if (type === 'number') return Number(value)
      return typeof value === 'string' ? value.trim() : value
    }

    function PersonaFile({ fileKey, name, available, draft, onReplace, canReplace, busy }) {
      const input = useRef(null)
      const pending = useRef(null)
      const [preview, setPreview] = useState(null)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')
      useEffect(() => () => pending.current?.abort(), [])
      useEffect(() => { setPreview(null) }, [draft])

      async function showPreview() {
        if (preview !== null) return setPreview(null)
        const requestController = new AbortController()
        pending.current = requestController
        setLoading(true)
        setError('')
        try {
          const file = await request('/documents/' + fileKey, { signal: requestController.signal })
          if (!requestController.signal.aborted) setPreview(file.text)
        } catch (failure) {
          if (!requestController.signal.aborted) setError(failure.message)
        } finally {
          if (!requestController.signal.aborted) setLoading(false)
        }
      }

      return h('div', { className: cls('document') },
        h('div', { className: cls('list-row') },
          h('div', null, h('strong', null, name),
            draft ? hint(t('待替换 · ', 'Pending replacement · ') + draft.name)
              : !available && hint(t('文件未创建', 'File has not been created'))),
          actions(button(loading ? t('正在打开…', 'Opening…') : preview === null ? t('预览', 'Preview') : t('收起预览', 'Close preview'),
            showPreview, { disabled: loading || !available, pressed: preview !== null }),
          button(t('替换', 'Replace'), () => input.current?.click(), { disabled: !canReplace || busy }))),
        h('input', { ref: input, type: 'file', hidden: true, accept: '.md,.markdown', onChange: async (event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          try {
            if (!/\.(md|markdown)$/i.test(file.name) || file.size > 512 * 1024) throw new Error(t('请选择 512 KB 以内的 Markdown 文件。', 'Choose a Markdown file up to 512 KB.'))
            const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
            onReplace({ name: file.name, text })
            setError('')
          } catch (failure) { setError(failure.message) }
        } }),
        error && h('p', { className: cls('error'), role: 'alert' }, error),
        preview !== null && h('pre', { className: cls('document-preview'), tabIndex: 0, 'aria-label': name },
          preview || t('文件为空', 'This file is empty')))
    }

    function Settings({ status, onSave, run, busy, drafts, setDrafts, selectedTarget, section, setSection }) {
      const [fileError, setFileError] = useState('')
      const group = groups.find((item) => item.id === section) ?? groups[0]
      const value = ({ key, type }) => drafts[key] ?? displayValue(settingsValue(status.settings, key), type)
      const update = (key, next) => setDrafts((prev) => ({ ...prev, [key]: next }))
      const changed = groups.flatMap((item) => item.fields).filter(({ key, type }) => Object.hasOwn(drafts, key)
        && JSON.stringify(parseValue(drafts[key], type)) !== JSON.stringify(settingsValue(status.settings, key)))
      const files = Object.entries(drafts).filter(([key]) => key.startsWith('documents.'))
      const hasChanges = Boolean(changed.length || files.length)
      const submit = (event) => {
        event.preventDefault()
        if (!hasChanges || busy || !status.canEdit) return
        const patch = {}
        for (const { key, type, min, max } of changed) {
          const next = parseValue(drafts[key], type)
          if (['number', 'percent'].includes(type) && (drafts[key] === '' || !Number.isFinite(next)
            || (min != null && Number(drafts[key]) < min) || (max != null && Number(drafts[key]) > max))) {
            setFileError(t('请检查设置值及其允许范围。', 'Check the setting values and their permitted ranges.'))
            return
          }
          const [root, child] = key.split('.')
          if (child) patch[root] = { ...patch[root], [child]: next }
          else patch[root] = next
        }
        if (files.length) patch.documents = Object.fromEntries(files.map(([key, file]) => [key.split('.')[1], file.text]))
        setFileError('')
        onSave(patch)
      }

      function renderField(item, disabled = false) {
        const { key, label, type, help } = item
        const id = P + key.replace('.', '-')
        const props = { id, name: key, disabled, 'aria-describedby': help ? id + '-hint' : undefined,
          onChange: (event) => update(key, type === 'boolean' ? event.target.checked : event.target.value) }
        if (type === 'boolean') return h('div', { key, className: cls('field') },
          h('label', { className: cls('switch') }, h('input', { ...props, checked: Boolean(value(item)), type: 'checkbox' }), label),
          help && h('span', { id: id + '-hint', className: cls('muted') }, help))
        const numeric = type === 'number' || type === 'percent'
        return h('div', { key, className: cls('field') }, h('label', { htmlFor: id }, label),
          type === 'list' ? h('textarea', { ...props, value: value(item), rows: 3 })
            : type === 'select' ? h('select', { ...props, value: value(item) },
              ...(item.options || []).map(([optVal, optLabel]) => h('option', { key: optVal, value: optVal }, optLabel)))
              : h('input', { ...props, value: value(item), type: numeric ? 'number' : 'text',
                min: item.min, max: item.max, step: item.step ?? (type === 'percent' ? 'any' : 1) }),
          help && h('span', { id: id + '-hint', className: cls('muted') }, help))
      }

      const sourceFields = group.id === 'sources' && h('div', { className: cls('stack') },
        renderField(group.fields[0]),
        h('div', { className: cls('setting-block') }, renderField(group.fields[1]),
          h('details', null, h('summary', null, t('手动拖选坐标', 'Manual drag coordinates')),
            hint(t('四项填 0 时自动定位，坐标以屏幕为基准。', 'Four zeros enable automatic placement. Coordinates are screen-relative.')),
            h('div', { className: cls('fields') }, ...group.fields.slice(2, 6).map((item) => renderField(item, !value(group.fields[1])))))),
        h('div', { className: cls('setting-block') }, renderField(group.fields[6]),
          renderField(group.fields[7], !value(group.fields[6])),
          renderField(group.fields[8], !value(group.fields[6]) || !value(group.fields[7]))),
        h('div', { className: cls('setting-block') }, renderField(group.fields[9]), renderField(group.fields[10], !value(group.fields[9]))))

      const personaFields = group.id === 'persona' && h('div', { className: cls('stack') },
        h('button', { type: 'button', className: cls('workspace-link'), disabled: busy,
          onClick: () => run('/workspace/open', {}),
          title: t(status.platform === 'win32' ? '在资源管理器打开工作目录' : '在 Finder 打开工作目录',
            status.platform === 'win32' ? 'Open the working directory in Explorer' : 'Open the working directory in Finder') }, status.agentDir),
        ...[['agent', 'AGENT.md'], ['persona', 'PERSONA.md'], ['memory', 'MEMORY.md']].map(([key, name]) =>
          h(PersonaFile, { key, fileKey: key, name, available: status.documents?.[key],
            draft: drafts['documents.' + key], canReplace: status.canEdit, busy,
            onReplace: (file) => update('documents.' + key, file) })))

      const advancedFields = group.id === 'advanced' && h('div', { className: cls('stack') },
        h('div', { className: cls('fields') }, ...group.fields.slice(0, 7).map((item) => renderField(item))),
        h('div', { className: cls('setting-block') },
          h('h4', null, t('防检测', 'Anti-detection')),
          hint(t('模拟真人输入习惯与运动轨迹，降低微信客户端对自动化脚本的行为特征识别风险。',
            'Simulate human typing, trajectories, and cadence to reduce WeChat client bot-detection risk.')),
          renderField(group.fields[7]),
          h('div', { className: cls('fields') },
            ...group.fields.slice(8).map((item) => renderField(item, !value(group.fields[7]))))))

      return h('form', { className: cls('settings stack'), onSubmit: submit, noValidate: true },
        h('div', { className: cls('toolbar save') }, title(t('机器人设置', 'Bot settings')),
          actions(
            button(t('默认值', 'Defaults'), () => setDrafts((prev) => ({ ...prev,
              ...Object.fromEntries(group.fields.map(({ key, type }) => [key, displayValue(settingsValue(status.defaults, key), type)])) })),
            { disabled: !group.fields.length || busy || !status.canEdit }),
            button(t('取消', 'Cancel'), () => { setDrafts({}); setFileError('') }, { disabled: !Object.keys(drafts).length || busy }),
            button(t('保存', 'Save'), undefined, { type: 'submit', tone: 'primary', disabled: !hasChanges || busy || !status.canEdit }))),
        fileError && h('p', { role: 'alert', className: cls('error') }, fileError),
        h('div', { className: cls('settings-layout') },
          h('nav', { className: cls('settings-nav'), 'aria-label': t('设置分类', 'Settings categories') },
            ...groups.map((item) => button(item.label, () => setSection(item.id), { key: item.id, pressed: item.id === group.id }))),
          h('div', { className: cls('stack') },
            group.id !== 'stickers' && h('fieldset', { className: cls('card'), disabled: group.id !== 'persona' && (busy || !status.canEdit) },
              title(group.label), sourceFields || personaFields || advancedFields ||
                h('div', { className: cls('fields') },
                  ...group.fields.filter((item) => !item.key.startsWith('replyDelay')).map((item) => renderField(item)),
                  group.id === 'reply' && h('fieldset', { className: cls('field-wide delay') },
                    h('legend', null, t('发送信息延时（秒）', 'Send delay (seconds)')),
                    h('div', { className: cls('fields') }, ...group.fields.slice(-2).map((item) => renderField(item)))))),
            group.id === 'stickers' && h(Stickers, { status, run, busy, selectedTarget }))))
    }

    function Stickers({ status, run, busy, selectedTarget }) {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [edit, setEdit] = useState(null)
      const [confirm, setConfirm] = useState(null)
      const [target, setTarget] = useState(selectedTarget ?? '')
      const [query, setQuery] = useState('')
      const [tag, setTag] = useState('')
      const [view, setView] = useState('available')
      useEffect(() => {
        const active = new AbortController()
        let timer
        const load = async () => {
          try {
            const next = await request('/stickers', { signal: active.signal })
            if (active.signal.aborted) return
            setData(next)
            if (next.job?.state === 'running') timer = window.setTimeout(load, 1500)
          } catch (failure) { if (!active.signal.aborted) setError(failure.message) }
        }
        load()
        return () => { active.abort(); window.clearTimeout(timer) }
      }, [data?.job?.state])

      const runSticker = async (path, body, message) => {
        const result = await run(path, body, message)
        if (result?.stickers) setData(result)
        return result
      }
      const job = data?.job
      const items = data?.stickers ?? []
      const targetObj = status.targets.find((item) => item.id === target)
      const targetCanSend = Boolean(targetObj && (targetObj.mode === 'clawbot' ? targetObj.ready : status.connected))
      const canSyncFavorites = Boolean(targetObj && targetObj.mode !== 'clawbot' && status.connected)
      const unlabeled = items.some((row) => row.available && !row.source)
      const normalize = (value) => String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase()
      const tags = new Map()
      for (const row of items) {
        if (view !== 'all' && !row.available) continue
        for (const label of row.tags) if (!tags.has(normalize(label))) tags.set(normalize(label), label)
      }
      const visible = items.filter((row) => (view === 'all' || row.available)
        && (view !== 'unlabeled' || !row.source)
        && (!tag || row.tags.some((label) => normalize(label) === tag))
        && (!query.trim() || [...row.tags, row.description].some((value) => normalize(value).includes(normalize(query)))))
      const close = () => setConfirm(null)
      return h('section', { className: cls('card stack') },
        h('div', { className: cls('toolbar') }, title(t('微信收藏表情', 'WeChat favorites')),
          actions(
            h('select', { 'aria-label': t('操作聊天', 'Chat for sticker operations'), value: target, onChange: (event) => { setTarget(event.target.value); close() } },
              h('option', { value: '' }, t('选择聊天', 'Choose a chat')),
              ...status.targets.map((chat) => h('option', { key: chat.id, value: chat.id }, chat.name))),
            button(t('获取全部收藏表情', 'Get all favorites'), () => runSticker('/stickers/sync', { targetId: target }, t('收藏已更新', 'Favorites updated')),
              { disabled: busy || !canSyncFavorites }),
            button(t('自动标注', 'Auto-label'), () => runSticker('/stickers/auto-label', {}, t('正在使用 DSH 标注', 'Labeling with DSH')),
              { disabled: busy || !unlabeled || job?.state === 'running' }))),
        error && h('p', { role: 'alert', className: cls('error') }, error),
        job?.state === 'running' && h('p', { role: 'status' }, t('标注进度 ', 'Labeling ') + job.processed + ' / ' + job.total),
        job?.state === 'done' && hint(t('已更新标注 ', 'Updated labels ') + job.updated),
        job?.state === 'error' && h('p', { role: 'alert', className: cls('error') }, job.error),
        data?.needsRescan ? hint(t('旧表情库已迁移。请重新获取收藏确认可用表情，原有标注可在「全部表情」查看。', 'The old library has migrated. Scan favorites again to confirm availability. Previous labels are under All stickers.'))
          : data?.scannedAt && !data.complete && hint(t('本次只获取到部分收藏，可以再次同步。', 'Only part of the library was scanned.')),
        items.length > 0 && h('div', { className: cls('toolbar') },
          actions(
            h('input', { type: 'search', value: query, 'aria-label': t('搜索收藏表情', 'Search favorite stickers'),
              placeholder: t('搜索标签或使用场景', 'Search labels or uses'), onChange: (event) => setQuery(event.target.value) }),
            h('select', { value: view, 'aria-label': t('按状态筛选表情', 'Filter stickers by status'), onChange: (event) => {
              setView(event.target.value); setTag(''); close()
            } },
            h('option', { value: 'available' }, t('可用表情', 'Available')),
            h('option', { value: 'unlabeled' }, t('待标注', 'Unlabeled')),
            h('option', { value: 'all' }, t('全部表情', 'All stickers'))),
            h('select', { value: tag, 'aria-label': t('按标签筛选表情', 'Filter stickers by tag'), onChange: (event) => setTag(event.target.value) },
              h('option', { value: '' }, t('全部标签', 'All labels')),
              ...[...tags.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([key, label]) => h('option', { key, value: key }, label)))),
          h('span', { className: cls('muted'), role: 'status' }, t('显示 ', 'Showing ') + visible.length + ' / ' + items.length)),
        data && !items.length && hint(t('暂无收藏表情', 'No favorite stickers')),
        items.length > 0 && !visible.length && hint(t('没有符合筛选条件的表情', 'No stickers match these filters')),
        h('div', { className: cls('sticker-grid') }, ...visible.map((row) =>
          h('article', { className: cls('sticker-cell'), key: row.id },
            h('img', { src: row.thumbnail, alt: row.tags.join('、') || t('收藏表情', 'Favorite sticker'), loading: 'lazy' }),
            edit?.id === row.id ? h('div', { className: cls('stack') },
              h('label', { className: cls('field') }, t('表情标签', 'Tags'),
                h('input', { value: edit.tags, onChange: (event) => setEdit({ ...edit, tags: event.target.value }) })),
              h('label', { className: cls('field') }, t('使用场景', 'When to use'),
                h('textarea', { value: edit.description, rows: 2, onChange: (event) => setEdit({ ...edit, description: event.target.value }) })),
              actions(button(t('取消', 'Cancel'), () => setEdit(null), { disabled: busy }),
                button(t('保存标注', 'Save label'), async () => {
                  if (await runSticker('/stickers/labels', edit, t('标注已保存', 'Label saved'))) setEdit(null)
                }, { disabled: busy, tone: 'primary' })))
              : h('div', { className: cls('stack') },
                h('strong', null, row.tags.join(' · ') || t('待标注', 'Unlabeled')),
                row.description && h('p', null, row.description),
                !row.available && hint(t('本次收藏中未找到', 'Unavailable in favorites')),
                confirm?.id === row.id ? h('div', { className: cls('stack') },
                  hint(confirm.action === 'remove' ? t('删除插件里的表情和标注。微信收藏仍会保留。', 'Remove the local sticker and label. It stays in WeChat favorites.')
                    : t('发送到所选聊天', 'Send to the selected chat')),
                  actions(button(t('取消', 'Cancel'), close, { disabled: busy }),
                    button(confirm.action === 'remove' ? t('确认删除', 'Confirm deletion') : t('确认发送', 'Confirm send'), async () => {
                      const result = confirm.action === 'remove'
                        ? await runSticker('/stickers/remove', { id: row.id }, t('表情已删除', 'Sticker removed'))
                        : await run('/stickers/send', { id: row.id, targetId: target }, t('表情已提交给微信', 'Sticker submitted to WeChat'))
                      if (result) { close(); if (confirm.action === 'remove') setTag('') }
                    }, { tone: 'danger', disabled: busy || (confirm.action === 'send' && !targetCanSend) })))
                  : actions(
                    button(t('编辑标注', 'Edit label'), () => { close(); setEdit({ id: row.id, tags: row.tags.join('，'), description: row.description }) }, { disabled: busy }),
                    button(t('发送…', 'Send…'), () => setConfirm({ id: row.id, action: 'send' }), { disabled: busy || !row.available || !targetCanSend }),
                    button(t('删除…', 'Delete…'), () => setConfirm({ id: row.id, action: 'remove' }), { disabled: busy, tone: 'danger' })))))))
    }

    function Activity({ run, busy }) {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [pending, setPending] = useState(null)
      const [filter, setFilter] = useState('')
      const load = async (signal) => {
        try { setData(await request('/sessions', { signal })); setError('') }
        catch (failure) { if (!signal?.aborted) setError(failure.message) }
      }
      useEffect(() => {
        const active = new AbortController()
        load(active.signal)
        return () => active.abort()
      }, [])
      const change = async (action, sessionId) => {
        const result = await run('/sessions', { action, sessionId }, action === 'delete'
          ? t('已安排退出后删除', 'Scheduled for deletion after exit') : t('会话状态已更新', 'Session updated'))
        if (!result) return
        setPending(null)
        await load()
      }
      const names = [...new Set(data?.sessions.map((row) => row.targetName).filter(Boolean))]
      const rows = (data?.sessions ?? []).filter((row) => !filter || (row.targetName || 'unassigned') === filter)
      const stages = { preparing: t('准备失败', 'Preparation failed'), waiting: t('待退出后删除', 'Pending application exit'),
        purged: t('已清理，待核对', 'Purged, awaiting verification'), verified: t('已彻底删除', 'Permanently deleted') }
      return h('section', { className: cls('card stack') },
        h('div', { className: cls('toolbar') }, title(t('会话记录管理', 'Session records')),
          actions(
            h('select', { 'aria-label': t('按聊天筛选', 'Filter by chat'), value: filter, onChange: (event) => setFilter(event.target.value) },
              h('option', { value: '' }, t('全部聊天', 'All chats')),
              ...names.map((name) => h('option', { key: name, value: name }, name)),
              h('option', { value: 'unassigned' }, t('未关联聊天', 'Unassigned chat'))),
            button(t('刷新', 'Refresh'), () => load(), { disabled: busy }))),
        error && h('p', { role: 'alert', className: cls('error') }, error),
        data && !rows.length && hint(t('暂无会话记录', 'No session records')),
        h('div', { className: cls('list') }, ...rows.map((row) => h('div', { key: row.sessionId, className: cls('list-row') },
          h('div', null, h('strong', null, row.targetName || t('未关联聊天', 'Unassigned chat')),
            hint((row.createdAt ? new Date(row.createdAt).toLocaleString() : row.sessionId) + ' · ' +
              (row.archived ? t('已归档', 'Archived') : t('未归档', 'Active')))),
          pending === row.sessionId ? actions(hint(t('退出 DSH 后将永久删除这段会话。', 'This session will be permanently deleted after DSH exits.')),
            button(t('取消', 'Cancel'), () => setPending(null), { disabled: busy }),
            button(t('确认删除', 'Confirm deletion'), () => change('delete', row.sessionId), { tone: 'danger', disabled: busy }))
            : actions(button(row.archived ? t('恢复', 'Restore') : t('归档', 'Archive'),
              () => change(row.archived ? 'restore' : 'archive', row.sessionId), { disabled: busy }),
            button(t('彻底删除…', 'Delete permanently…'), () => setPending(row.sessionId), { disabled: busy || !data?.canDelete, tone: 'danger' }))))),
        ...(data?.deletions ?? []).map((row) => h('div', { key: row.id, className: cls('list-row') },
          h('span', null, row.targetName || row.id), h('span', { role: 'status' }, stages[row.stage] ?? row.stage),
          row.error && h('span', { className: cls('error') }, row.error))))
    }

    function Targets({ status, selected, select, run, busy }) {
      const [draft, setDraft] = useState(null)
      const [name, setName] = useState('')
      const [mode, setMode] = useState('group')
      const [results, setResults] = useState(null)
      const [matches, setMatches] = useState([])
      const [finding, setFinding] = useState(false)
      const [qr, setQr] = useState(null)
      const [verifyCode, setVerifyCode] = useState('')
      const [error, setError] = useState('')
      const qrMetaRef = useRef({ label: '', targetIndex: null })
      const rows = draft ?? status.targets
      const serializeTargets = (list) => list.map(({ name: itemName, mode: itemMode, accountId, userId }) =>
        itemMode === 'clawbot'
          ? { name: itemName, mode: 'clawbot', accountId, ...(userId ? { userId } : {}) }
          : { name: itemName, mode: itemMode })
      const defaultClawbotName = () => {
        const base = t('官方私聊', 'ClawBot 私聊')
        if (!rows.some((r) => r.name === base)) return base
        for (let i = 2; i <= 20; i += 1) {
          const candidate = `${base} ${i}`
          if (!rows.some((r) => r.name === candidate)) return candidate
        }
        return `${base}-${Date.now().toString(36).slice(-4)}`
      }
      const edit = (index, patch) => setDraft(rows.map((row, position) => position === index ? { ...row, ...patch } : row))
      const add = (names) => {
        const next = [...rows, ...names.map((n) => ({ name: n, mode }))]
        if (next.length > 10) return setError(t('最多配置 10 个聊天。', 'Configure up to 10 chats.'))
        setDraft(next)
        setName('')
        setMatches([])
        setError('')
      }
      const find = async () => {
        setFinding(true)
        setError('')
        try { setResults((await request('/targets')).candidates) }
        catch (failure) { setError(failure.message) }
        finally { setFinding(false) }
      }
      const startQr = async (rebindIndex = null) => {
        setError('')
        setVerifyCode('')
        const existing = rebindIndex != null ? rows[rebindIndex] : null
        const initialLabel = existing?.name || defaultClawbotName()
        qrMetaRef.current = { label: initialLabel, targetIndex: rebindIndex }
        try {
          const res = await request('/ilink/login/start', {
            body: { accountId: existing?.accountId || '', force: true },
          })
          setQr({ ...res, targetIndex: rebindIndex, label: initialLabel })
        } catch (failure) {
          setError(failure.message)
        }
      }
      const submitVerify = async () => {
        if (!qr?.sessionKey || !verifyCode.trim()) return
        setError('')
        try {
          const next = await request('/ilink/login/verify', { body: { sessionKey: qr.sessionKey, code: verifyCode.trim() } })
          setVerifyCode('')
          setQr((prev) => (prev ? { ...prev, ...next } : prev))
        } catch (failure) {
          setError(failure.message)
        }
      }
      const cancelQr = () => {
        const key = qr?.sessionKey
        setQr(null)
        setVerifyCode('')
        if (key) request('/ilink/login/cancel', { body: { sessionKey: key } }).catch(() => {})
      }

      useEffect(() => {
        if (!qr?.sessionKey || qr.done) return
        const active = new AbortController()
        let timer
        const tick = async () => {
          try {
            const next = await request('/ilink/login/status', {
              body: { sessionKey: qr.sessionKey },
              signal: active.signal,
            })
            if (active.signal.aborted) return
            setQr((prev) => (prev && prev.sessionKey === next.sessionKey ? { ...prev, ...next } : prev))
            if (next.connected && next.accountId) {
              const { label, targetIndex } = qrMetaRef.current
              const baseRows = draft ?? status.targets
              const finalName = (label || '').trim() || defaultClawbotName()
              const nextRows = targetIndex != null
                ? baseRows.map((row, idx) => idx === targetIndex
                  ? { ...row, accountId: next.accountId, userId: next.userId || row.userId || '' }
                  : row)
                : [...baseRows, { name: finalName, mode: 'clawbot', accountId: next.accountId, userId: next.userId || '' }]
              const saved = await run('/settings', { targets: serializeTargets(nextRows) }, t('已绑定并保存官方私聊通道', 'Official ClawBot channel bound and saved'))
              if (saved) {
                setDraft(null)
                setQr(null)
              }
              return
            }
            if (!next.done) timer = window.setTimeout(tick, next.needVerifyCode ? 2000 : 1200)
          } catch (failure) {
            if (!active.signal.aborted) setError(failure.message)
          }
        }
        timer = window.setTimeout(tick, 1200)
        return () => { active.abort(); window.clearTimeout(timer) }
      }, [qr?.sessionKey, qr?.done, qr?.needVerifyCode])

      const modeSelect = (value, onChange) => h('select', { 'aria-label': t('聊天模式', 'Chat mode'), value,
        onChange: (event) => onChange(event.target.value) },
      h('option', { value: 'group' }, t('群聊', 'Group')), h('option', { value: 'private' }, t('私聊', 'Private')))
      const modeBadge = (itemMode) => itemMode === 'clawbot'
        ? t('官方私聊', 'ClawBot')
        : itemMode === 'private' ? t('私聊', 'Private') : t('群聊', 'Group')

      return h('section', { className: cls('card chat-config stack') },
        h('div', { className: cls('toolbar') }, title(t('聊天配置', 'Chat targets')), hint(rows.length + ' / 10')),
        !rows.length && hint(t('尚未配置聊天', 'No chats configured')),
        h('div', { className: cls('list') }, ...rows.map((row, index) => {
          const live = status.targets.find((item) => item.id === row.id)
          const isClawbot = row.mode === 'clawbot'
          const readyLabel = isClawbot
            ? (live?.tokenStale ? t('凭证过期', 'Token expired') : live?.ready ? t('就绪', 'Ready') : t('未就绪', 'Not ready'))
            : (live?.ready ? t('就绪', 'Ready') : t('未就绪', 'Not ready'))
          return h('div', { className: cls('list-row'), key: row.id ?? index },
            row.editing ? actions(
              h('input', { 'aria-label': t('聊天名称', 'Chat name'), value: row.name, onChange: (event) => edit(index, { name: event.target.value }) }),
              isClawbot ? hint('【' + modeBadge(row.mode) + '】') : modeSelect(row.mode, (value) => edit(index, { mode: value })))
              : h('div', { className: cls('target-name') },
                button(row.name + '【' + modeBadge(row.mode) + '】', () => select(row.id),
                  { disabled: !live, pressed: selected === row.id }),
                h('span', { className: cls('status'), 'data-ready': String(Boolean(live?.ready)) }, readyLabel)),
            hint(t('待处理 ', 'Pending ') + (live?.pending ?? 0)),
            actions(
              isClawbot
                ? button(t('重新扫码', 'Rescan QR'), () => startQr(index), { disabled: busy || !status.canEdit })
                : button(t('准备窗口', 'Prepare window'), () => run('/window', { targetId: row.id }, t('窗口已就绪', 'Window ready')),
                  { disabled: !live || !status.connected || busy }),
              button(t('编辑', 'Edit'), () => edit(index, { editing: !row.editing }), { disabled: busy || !status.canEdit }),
              button(t('移除', 'Remove'), () => setDraft(rows.filter((_, i) => i !== index)), { disabled: busy || !status.canEdit })))
        })),
        h('div', { className: cls('toolbar') }, actions(
          h('input', { 'aria-label': t('添加聊天', 'Add a chat'), placeholder: t('输入完整聊天名', 'Enter the full chat name'), value: name,
            onChange: (event) => setName(event.target.value) }),
          modeSelect(mode, setMode),
          button(t('添加', 'Add'), () => add([name.trim()]), { disabled: !name.trim() || rows.length >= 10 || busy || !status.canEdit }),
          button(finding ? t('查找中…', 'Searching…') : t('查找微信聊天', 'Find WeChat chats'), find, { disabled: finding || busy || rows.length >= 10 || !status.canEdit }),
          button(t('扫码添加官方私聊', 'Scan QR for ClawBot'), () => startQr(null), { disabled: Boolean(qr && !qr.done) || rows.length >= 10 || busy || !status.canEdit, tone: 'primary' })),
        draft && actions(button(t('取消', 'Cancel'), () => { setDraft(null); setError('') }, { disabled: busy }),
          button(t('保存聊天', 'Save chats'), async () => {
            const result = await run('/settings', { targets: serializeTargets(rows) }, t('聊天配置已保存', 'Chat targets saved'))
            if (result) setDraft(null)
          }, { tone: 'primary', disabled: busy || !status.canEdit }))),
        qr && h('div', { className: cls('setting-block') },
          h('div', { className: cls('toolbar') },
            h('strong', null, qr.targetIndex != null ? t('重新扫码绑定官方私聊', 'Re-bind ClawBot QR') : t('微信扫码添加官方私聊（ClawBot）', 'Bind WeChat Official ClawBot')),
            actions(
              button(t('刷新二维码', 'Refresh QR'), () => startQr(qr.targetIndex), { disabled: busy }),
              button(t('取消扫码', 'Cancel'), cancelQr, { disabled: busy }))),
          qr.targetIndex == null && h('div', { className: cls('field') },
            h('label', null, t('对话名称', 'Chat display name')),
            h('input', {
              value: qr.label ?? '',
              placeholder: t('如：主人私聊', 'e.g. Personal ClawBot'),
              onChange: (event) => {
                const nextLabel = event.target.value
                qrMetaRef.current.label = nextLabel
                setQr((prev) => (prev ? { ...prev, label: nextLabel } : prev))
              },
            })),
          qr.qrImage && h('img', { src: qr.qrImage, alt: t('微信官方 ClawBot 登录二维码', 'WeChat ClawBot QR code'), style: { width: '188px', height: '188px', borderRadius: '8px', border: '1px solid var(--wb-border)' } }),
          h('p', { className: qr.status === 'error' ? cls('error') : cls('muted'), role: 'status' }, qr.message),
          qr.qrcodeUrl && hint(t('备用链接：', 'QR URL: ') + qr.qrcodeUrl),
          qr.needVerifyCode && actions(
            h('input', {
              'aria-label': t('手机微信配对码', 'WeChat verify code'),
              placeholder: t('输入手机显示的配对数字', 'Enter code shown on phone'),
              value: verifyCode,
              onChange: (event) => setVerifyCode(event.target.value),
            }),
            button(t('提交配对码', 'Submit code'), submitVerify, { tone: 'primary', disabled: !verifyCode.trim() || busy }))),
        results && h('div', { className: cls('target-candidates stack') },
          h('input', { 'aria-label': t('筛选候选聊天', 'Filter chats'), placeholder: t('搜索候选聊天', 'Search matches'), value: name,
            onChange: (event) => setName(event.target.value) }),
          h('div', { className: cls('candidate-list') }, ...results.filter((row) => row.name.includes(name)
            && !rows.some((saved) => saved.name === row.name)).map((row) => h('label', { key: row.name, className: cls('switch') },
            h('input', { type: 'checkbox', checked: matches.includes(row.name), onChange: (event) =>
              setMatches(event.target.checked ? [...matches, row.name] : matches.filter((value) => value !== row.name)) }), row.name))),
          actions(button(t('添加选中聊天', 'Add selected chats'), () => add(matches), { disabled: !matches.length || busy || !status.canEdit }),
            button(t('关闭', 'Close'), () => { setResults(null); setMatches([]) }))),
        error && h('p', { className: cls('error'), role: 'alert' }, error))
    }

    function Overview({ status, busy, run, selected, select }) {
      const target = status.targets.find((item) => item.id === selected)
        ?? status.targets.find((item) => item.ready) ?? status.targets[0]
      const totals = [[t('今日收到', 'Received today'), status.totals.received],
        [t('发送提交', 'Submitted'), status.totals.submitted], [t('发送失败', 'Failed'), status.totals.failed]]
      return h('div', { className: cls('grid') },
        h('section', { className: cls('card stack') },
          title(t('运行概况', 'Activity overview')),
          h('dl', { className: cls('metrics') }, ...totals.map(([label, value]) =>
            h('div', { key: label }, h('dt', null, label), h('dd', null, value)))),
          h('h4', null, t('最近发言', 'Recent sends')),
          !status.recentSends.length && hint(t('暂无发送记录', 'No recent sends')),
          ...status.recentSends.map((row, index) => h('div', { key: row.at + '-' + index, className: cls('send-item') },
            h('div', { className: cls('toolbar') }, h('strong', null, row.targetName),
              h('time', { dateTime: new Date(row.at).toISOString() }, new Date(row.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))),
            row.thumbnail && h('img', { src: row.thumbnail, alt: row.content }),
            h('p', null, row.content)))),
        h(Preview, {
          key: (target?.id ?? 'main') + ':' + status.connected,
          connected: status.connected,
          target,
          captureProtected: Boolean(status.settings?.captureProtected ?? status.captureProtected),
          windowCaptureProtected: status.windowCaptureProtected === true,
          canEdit: status.canEdit,
          busy,
          onToggleCaptureProtected: (next) => run('/settings', { captureProtected: next },
            next ? t('已开启防截屏模式', 'Capture-protected mode enabled') : t('已关闭防截屏模式', 'Capture-protected mode disabled')),
        }),
        h(Targets, { status, selected: target?.id, select, run, busy }))
    }

    function PanelBody() {
      const [tab, setTab] = useState('overview')
      const [status, setStatus] = useState(null)
      const [loading, setLoading] = useState(false)
      const [operation, setOperation] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [drafts, setDrafts] = useState({})
      const [selectedTarget, setSelectedTarget] = useState(null)
      const [settingsSection, setSettingsSection] = useState('sources')

      useEffect(() => {
        if (!notice) return
        const timer = window.setTimeout(() => setNotice(''), 3500)
        return () => window.clearTimeout(timer)
      }, [notice])

      const refresh = async (signal, quiet = false) => {
        if (!quiet) setLoading(true)
        try {
          const result = await request('/status', { signal })
          if (!signal?.aborted) setStatus(result)
          return result
        } catch (failure) {
          if (!quiet && !signal?.aborted) setError(failure.message)
          return null
        } finally { if (!quiet && !signal?.aborted) setLoading(false) }
      }

      useEffect(() => {
        const active = new AbortController()
        refresh(active.signal)
        return () => active.abort()
      }, [])

      useEffect(() => {
        if (tab !== 'overview') return
        const active = new AbortController()
        let timer
        const tick = async () => {
          if (!document.hidden) await refresh(active.signal, true)
          if (!active.signal.aborted) timer = window.setTimeout(tick, 5000)
        }
        timer = window.setTimeout(tick, 5000)
        return () => { active.abort(); window.clearTimeout(timer) }
      }, [tab])

      const run = async (path, body, message) => {
        if (operation) return null
        setOperation(path)
        setError('')
        setNotice('')
        try {
          const result = await request(path, { body })
          const next = await refresh()
          const stopped = path === '/settings' && status.detector?.running && next?.detector?.running === false
          setNotice(stopped ? t('设置已保存，机器人已停止。', 'Settings saved. The bot stopped.') : message)
          return result
        } catch (failure) {
          setError(failure.message)
          return null
        } finally { setOperation('') }
      }

      const save = async (patch) => {
        const result = await run('/settings', patch, t('设置已保存', 'Settings saved'))
        if (result) setDrafts({})
      }
      const busy = Boolean(operation)
      const running = status?.detector?.running
      const statusLabel = status
        ? running ? t('运行中', 'Running') : t('已停止', 'Stopped')
        : loading ? t('连接中', 'Connecting') : t('状态不可用', 'Status unavailable')
      const nav = [
        ['overview', t('概览', 'Overview')],
        ['settings', t('机器人设置', 'Bot settings')],
        ['activity', t('会话记录管理', 'Session records')],
      ]
      return h('div', { 'data-dsh-wechatbot': true },
        h('style', null, css),
        h('header', { className: cls('head') },
          h('div', { className: cls('heading') },
            h('h2', null, t('微信机器人', 'WeChat bot')),
            h('span', { className: cls('status'), 'data-running': String(Boolean(running)) }, statusLabel)),
          actions(
            button(t('刷新状态', 'Refresh status'), () => { setError(''); refresh() }, { disabled: loading || busy }),
            running && button(t('立即巡检', 'Scan now'),
              () => run('/detector', { action: 'scan' }, t('巡检完成', 'Scan complete')),
              { disabled: busy || status.settings.ocrEnabled === false || (status.settings.captureProtected && status.platform !== 'win32') }),
            status && button(
              running ? t('停止', 'Stop') : t('启动', 'Start'),
              () => run('/detector', { action: running ? 'stop' : 'start' },
                running ? t('机器人已停止', 'Bot stopped') : t('机器人已启动', 'Bot started')),
              { disabled: busy || (!running && !(status.canStart ?? (status.targets.length && status.connected))), tone: running ? undefined : 'primary' }))),
        h('nav', { className: cls('nav'), 'aria-label': t('微信机器人面板', 'WeChat bot panel') },
          ...nav.map(([value, label]) => h('button', {
            key: value, type: 'button', 'aria-pressed': tab === value, onClick: () => setTab(value),
          }, label))),
        error && h('div', { className: cls('banner error'), role: 'alert' }, error),
        notice && h('div', { className: cls('banner'), role: 'status' }, notice),
        status && tab === 'overview' && h(Overview, { status, busy, run, selected: selectedTarget, select: setSelectedTarget }),
        status && tab === 'settings' && h(Settings, { status, onSave: save, run, busy, drafts, setDrafts, selectedTarget, section: settingsSection, setSection: setSettingsSection }),
        status && tab === 'activity' && h(Activity, { run, busy }))
    }

    function Panel(props) {
      return props?.view === 'summary' ? null : h(PanelBody)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-wechatbot',
        }, Panel))
      },
    }
  },
})
