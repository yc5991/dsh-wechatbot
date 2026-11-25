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
        --wb-border: var(--dsw-alias-border-l2, #dce0e7);
        --wb-surface: var(--dsw-alias-bg-layer-1, #fff);
        --wb-bg: var(--dsw-alias-bg-base, #f6f7fa);
        --wb-brand: #3158ce;
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
      .dshwb-status[data-running="true"]::before { background: #258450; }
      .dshwb-nav { display: flex; flex-wrap: wrap; gap: 18px; border-bottom: 1px solid var(--wb-border); margin-bottom: 16px; }
      .dshwb-nav button { appearance: none; border: 0; border-bottom: 2px solid transparent; border-radius: 4px 4px 0 0; padding: 8px 2px; background: transparent; color: var(--wb-muted); font: inherit; cursor: pointer; }
      .dshwb-nav button[aria-pressed="true"] { color: var(--wb-fg); border-bottom-color: var(--wb-brand); font-weight: 650; }
      .dshwb-btn { min-height: 34px; padding: 5px 12px; color: var(--wb-fg); border: 1px solid var(--wb-border); border-radius: 7px; background: var(--wb-surface); font: inherit; font-size: 13px; cursor: pointer; }
      .dshwb-btn:hover:not(:disabled) { background: var(--wb-bg); }
      .dshwb-btn[data-tone="primary"] { background: var(--wb-brand); border-color: var(--wb-brand); color: #fff; }
      .dshwb-btn[data-tone="primary"]:hover:not(:disabled) { background: #2649b5; }
      .dshwb-btn[data-tone="danger"] { color: var(--wb-danger); }
      .dshwb-btn:disabled { opacity: .55; cursor: default; }
      [data-dsh-wechatbot] :focus-visible { outline: 2px solid var(--wb-brand); outline-offset: 2px; }
      .dshwb-grid { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); gap: 14px; align-items: start; }
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
      .dshwb-field input:not([type="checkbox"]), .dshwb-field textarea, .dshwb-field select {
        background: var(--wb-bg); border: 1px solid var(--wb-border); color: var(--wb-fg); border-radius: 7px; padding: 6px 9px; min-height: 34px; width: 100%; font: inherit;
      }
      .dshwb-field textarea { resize: vertical; }
      .dshwb-field input[type="checkbox"] { accent-color: var(--wb-brand); width: 16px; height: 16px; margin: 0; }
      .dshwb-switch { display: flex; align-items: center; gap: 8px; min-height: 28px; }
      .dshwb-settings fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
      .dshwb-settings fieldset:disabled { opacity: .72; }
      .dshwb-settings summary { cursor: pointer; font-weight: 650; }
      .dshwb-save { position: sticky; bottom: 0; z-index: 1; background: var(--wb-surface); border-top: 1px solid var(--wb-border); padding: 10px 0 2px; }
      @media (max-width: 720px) { .dshwb-grid, .dshwb-fields { grid-template-columns: minmax(0, 1fr); } }
    `

    const cls = (name) => P + name.split(' ').join(' ' + P)
    const title = (text) => h('h3', null, text)
    const hint = (text) => h('p', { className: cls('muted') }, text)
    const actions = (...children) => h('div', { className: cls('actions') }, ...children)
    const button = (text, onClick, opts = {}) => h('button', {
      type: opts.type || 'button', className: cls('btn'), onClick, disabled: opts.disabled,
      'data-tone': opts.tone, 'aria-pressed': opts.pressed,
    }, text)

    function Preview({ attached }) {
      const [shot, setShot] = useState(null)
      const [live, setLive] = useState(false)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')
      const controller = useRef(null)
      const url = useRef(null)

      const capture = async () => {
        if (controller.current || document.hidden) return false
        const active = new AbortController()
        controller.current = active
        setLoading(true)
        setError('')
        try {
          const image = await request('/screenshot', { body: {}, signal: active.signal })
          if (active.signal.aborted) return false
          if (url.current) URL.revokeObjectURL(url.current)
          url.current = URL.createObjectURL(image)
          setShot({ src: url.current, at: new Date() })
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
        const hide = () => {
          if (document.hidden) {
            setLive(false)
            controller.current?.abort()
          }
        }
        document.addEventListener('visibilitychange', hide)
        return () => {
          document.removeEventListener('visibilitychange', hide)
          controller.current?.abort()
          controller.current = null
          if (url.current) URL.revokeObjectURL(url.current)
        }
      }, [])

      useEffect(() => {
        if (!live) return
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
      }, [live])

      return h('section', { className: cls('card') },
        title(t('微信窗口预览', 'WeChat window preview')),
        hint(t('在面板查看当前窗口。实时预览开启后约每 5 秒更新，离开页面即暂停。',
          'View the current window here. Live preview refreshes about every 5 seconds and stops when you leave.')),
        h('div', { className: cls('frame'), 'aria-busy': loading },
          shot
            ? h('img', { src: shot.src, alt: t('微信聊天窗口截图', 'Screenshot of the WeChat chat window') })
            : hint(loading ? t('正在截取窗口…', 'Capturing the window…') : t('预览尚未开启', 'Preview is off'))),
        h('div', { className: cls('toolbar') },
          actions(
            button(t('截取一张', 'Capture once'), capture, { disabled: live || loading }),
            button(live ? t('暂停实时预览', 'Pause live preview') : t('开启实时预览', 'Start live preview'),
              () => setLive(!live), { disabled: loading && !live, pressed: live, tone: live ? undefined : 'primary' })),
          shot && h('span', { className: cls('muted'), role: 'status' }, shot.at.toLocaleTimeString())),
        error && h('p', { className: cls('error'), role: 'alert' }, error),
        hint(attached
          ? t('模型截图已启用，只在提交回复轮时附上。', 'Model screenshots are enabled and are attached when a reply turn is submitted.')
          : t('模型截图已关闭，面板预览仍可单独使用。', 'Model screenshots are off. The panel preview is available separately.')))
    }

    const field = (key, label, type = 'text', options = {}) => ({ key, label, type, ...options })
    const fieldGroups = [
      {
        label: t('目标聊天', 'Target chat'),
        fields: [
          field('expectedGroup', t('聊天名称', 'Chat name'), 'target', { help: t('输入微信窗口显示的完整名称。', 'Enter the full title shown in WeChat.') }),
          field('chatMode', t('聊天模式', 'Chat mode'), 'choice', { options: { group: t('群聊', 'Group'), private: t('私聊', 'Private') } }),
        ],
      },
      {
        label: t('检测与读屏', 'Detection and vision'),
        fields: [
          field('trigger.onNotification', t('收到系统通知时检测', 'Watch system notifications'), 'boolean'),
          field('scan.enabled', t('定时读屏巡检', 'Scan the chat on an interval'), 'boolean', { help: t('通过 OCR 识别窗口中的消息，微信可留在后台。', 'Uses OCR to read the chat while WeChat stays in the background.') }),
          field('scan.intervalMinutes', t('巡检间隔（分钟）', 'Scan interval (minutes)'), 'number', { min: 1, max: 120 }),
          field('attachScreenshot', t('给模型附上聊天截图', 'Attach chat screenshots to model turns'), 'boolean', { help: t('仅在发起模型回复时生效，与面板实时预览独立。', 'Applies to reply turns and is independent of panel preview.') }),
          field('screenshotMaxWidth', t('模型截图最大宽度（像素）', 'Max model screenshot width (pixels)'), 'number', { min: 320, max: 1600 }),
        ],
      },
      {
        label: t('回复行为', 'Reply behavior'),
        collapsed: true,
        fields: [
          field('atKeywords', t('召唤关键词', 'Mention keywords'), 'list'),
          field('proactiveReplyProbability', t('群聊主动接话概率（%）', 'Proactive group reply chance (%)'), 'percent', { min: 0, max: 100 }),
          field('replyCooldownSeconds', t('群聊回复冷却（秒）', 'Group reply cooldown (seconds)'), 'number', { min: 0, max: 600 }),
          field('dailyProactiveLimit', t('每日主动发言上限', 'Daily proactive reply limit'), 'number', { min: 0, max: 10000, help: t('0 表示不限。被 @ 的回复不计入。', '0 means unlimited. Mentions are exempt.') }),
          field('maxMessageChars', t('单条消息字数上限', 'Max characters per message'), 'number', { min: 20, max: 2000 }),
          field('maxMessagesPerCall', t('一次最多连续发送几条', 'Max bubbles per send'), 'number', { min: 1, max: 20 }),
          field('maxEmojiPerMessage', t('单条微信表情上限', 'Max WeChat emojis per message'), 'number', { min: 0, max: 5 }),
          field('replyDelayMinSeconds', t('最短发送延迟（秒）', 'Min send delay (seconds)'), 'number', { min: 0, max: 10, step: 0.1 }),
          field('replyDelayMaxSeconds', t('最长发送延迟（秒）', 'Max send delay (seconds)'), 'number', { min: 0, max: 30, step: 0.1 }),
          field('knownVeterans', t('熟人名单', 'Known participants'), 'list'),
          field('jargonKeywords', t('技术话题关键词', 'Technical topic keywords'), 'list'),
        ],
      },
      {
        label: t('会话与记忆', 'Sessions and memory'),
        collapsed: true,
        fields: [
          field('reuseWindowMinutes', t('会话复用窗口（分钟）', 'Session reuse window (minutes)'), 'number', { min: 1, max: 60 }),
          field('archiveAfterMinutes', t('静默归档时间（分钟）', 'Archive after inactivity (minutes)'), 'number', { min: 1, max: 120 }),
          field('memoryMaxEntries', t('记忆保留条数', 'Memory entries retained'), 'number', { min: 5, max: 500 }),
          field('memoryPromptEntries', t('每轮带入的记忆条数', 'Memory entries per prompt'), 'number', { min: 0, max: 20 }),
          field('maxPromptChars', t('每轮文本上限（字符）', 'Prompt text limit (characters)'), 'number', { min: 2000, max: 100000 }),
          field('agentPreset', t('DSH 会话预设', 'DSH session preset')),
          field('workspaceTitle', t('DSH 工作区名称', 'DSH workspace name')),
          field('agentDir', t('人设与记忆目录', 'Persona and memory directory'), 'text', { help: t('留空使用插件默认目录。', 'Leave empty to use the plugin default.') }),
        ],
      },
      {
        label: t('高级设置', 'Advanced settings'),
        description: t('拖选坐标使用屏幕绝对坐标，四项均为 0 时自动定位。', 'Drag points use absolute screen coordinates. Set all four to 0 for automatic positioning.'),
        collapsed: true,
        fields: [
          field('stickerDir', t('表情包目录', 'Sticker directory'), 'text', { help: t('留空使用插件默认目录。', 'Leave empty to use the plugin default.') }),
          field('whitelistGroups', t('额外识别的聊天名', 'Additional recognized chat names'), 'list'),
          field('dragPoints.x1', t('拖选起点 X', 'Drag start X'), 'number'),
          field('dragPoints.y1', t('拖选起点 Y', 'Drag start Y'), 'number'),
          field('dragPoints.x2', t('拖选终点 X', 'Drag end X'), 'number'),
          field('dragPoints.y2', t('拖选终点 Y', 'Drag end Y'), 'number'),
        ],
      },
    ]

    function settingsValue(settings, key) {
      return key.split('.').reduce((value, part) => value?.[part], settings)
    }

    function displayValue(value, type) {
      if (type === 'list') return (value || []).join('\n')
      if (type === 'percent') return value === undefined ? '' : Number((value * 100).toFixed(4))
      return value ?? ''
    }

    function parseValue(value, type) {
      if (type === 'list') return [...new Set(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))]
      if (type === 'percent') return Number(value) / 100
      if (type === 'number') return Number(value)
      return typeof value === 'string' ? value.trim() : value
    }

    function Settings({ status, onSave, busy, drafts, setDrafts }) {
      const [targets, setTargets] = useState(null)
      const [targetError, setTargetError] = useState('')
      const [finding, setFinding] = useState(false)
      const settings = status.settings || {}
      const draftValue = ({ key, type }) => drafts[key] ?? displayValue(settingsValue(settings, key), type)
      const update = (key, value) => setDrafts((previous) => ({ ...previous, [key]: value }))
      const changed = fieldGroups.flatMap((group) => group.fields)
        .filter(({ key, type }) => Object.hasOwn(drafts, key)
          && JSON.stringify(parseValue(drafts[key], type)) !== JSON.stringify(settingsValue(settings, key)))

      const submit = (event) => {
        event.preventDefault()
        if (!changed.length || busy || !status.canEdit) return
        const patch = {}
        for (const { key, type } of changed) {
          const [root, child] = key.split('.')
          const value = parseValue(drafts[key], type)
          if (child) patch[root] = { ...patch[root], [child]: value }
          else patch[root] = value
        }
        onSave(patch)
      }

      const findTargets = async () => {
        setFinding(true)
        setTargetError('')
        try {
          const result = await request('/targets')
          setTargets(result.candidates)
        } catch (failure) {
          setTargetError(failure.message)
        } finally { setFinding(false) }
      }

      const renderField = (item) => {
        const { key, label, type, help } = item
        const id = P + key.replace('.', '-')
        const props = {
          id, name: key, 'aria-describedby': help || type === 'list' ? id + '-hint' : undefined,
          value: draftValue(item), onChange: (event) => update(key, event.target.value),
        }
        if (type === 'boolean') {
          return h('div', { key, className: cls('field') },
            h('label', { className: cls('switch') },
              h('input', {
                id, name: key, type: 'checkbox', checked: Boolean(draftValue(item)),
                'aria-describedby': props['aria-describedby'],
                onChange: (event) => update(key, event.target.checked),
              }), label),
            help && h('span', { id: id + '-hint', className: cls('muted') }, help))
        }
        const numeric = type === 'number' || type === 'percent'
        let control
        if (type === 'list') control = h('textarea', { ...props, rows: 3 })
        else if (type === 'choice') {
          control = h('select', props, Object.entries(item.options).map(([value, name]) => h('option', { key: value, value }, name)))
        } else {
          control = h('input', { ...props, type: numeric ? 'number' : 'text', required: numeric,
            min: item.min, max: item.max, step: item.step ?? (type === 'percent' ? 'any' : 1) })
        }
        return h('div', { key, className: cls('field') },
          h('label', { htmlFor: id }, label),
          control,
          (help || type === 'list') && h('span', { id: id + '-hint', className: cls('muted') }, help || t('每行一项。', 'One item per line.')),
          type === 'target' && actions(
            button(finding ? t('查找中…', 'Finding…') : t('查找微信聊天', 'Find WeChat chats'), findTargets, { disabled: finding }),
            targets?.length > 0 && h('select', {
              'aria-label': t('选择候选聊天', 'Choose a detected chat'),
              value: targets.some((row) => row.name === draftValue(item)) ? draftValue(item) : '',
              onChange: (event) => update(key, event.target.value),
            },
            h('option', { value: '', disabled: true }, t('选择候选聊天', 'Choose a detected chat')),
            ...targets.map((row) => h('option', { key: row.name, value: row.name }, row.name))),
            targets?.length === 0 && hint(t('没有找到候选聊天，可以手动输入。', 'No chats found. You can enter a name manually.'))),
          type === 'target' && targetError && h('p', { className: cls('error'), role: 'alert' }, targetError))
      }

      return h('form', { className: cls('settings stack'), onSubmit: submit },
        !status.canEdit && hint(t('当前插件配置无法编辑。', 'The plugin settings are read-only here.')),
        h('fieldset', { className: cls('stack'), disabled: busy || !status.canEdit },
          ...fieldGroups.map((group) => {
            const content = h('div', { className: cls('fields') }, ...group.fields.map(renderField))
            if (group.collapsed) {
              return h('details', { key: group.label, className: cls('card'), open: group.fields.some((item) => Object.hasOwn(drafts, item.key)) || undefined },
                h('summary', null, group.label), group.description && hint(group.description), content)
            }
            return h('section', { key: group.label, className: cls('card') }, title(group.label), content)
          })),
        h('div', { className: cls('toolbar save') },
          hint(changed.length > 0 ? t('有未保存的更改', 'Unsaved changes') : t('所有设置已保存', 'Settings are up to date')),
          actions(
            button(t('还原', 'Discard changes'), () => setDrafts({}), { disabled: !Object.keys(drafts).length || busy }),
            button(busy ? t('保存中…', 'Saving…') : t('保存设置', 'Save settings'), undefined,
              { type: 'submit', tone: 'primary', disabled: !changed.length || busy || !status.canEdit }))))
    }

    function Stickers({ target, run }) {
      const [list, setList] = useState(null)
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(false)
      const [chosen, setChosen] = useState('')
      const load = async () => {
        setLoading(true)
        setError('')
        try { setList(await request('/stickers')) }
        catch (failure) { setError(failure.message) }
        finally { setLoading(false) }
      }
      return h('section', { className: cls('card') },
        h('div', { className: cls('toolbar') }, title(t('表情包', 'Stickers')),
          button(list ? t('刷新目录', 'Refresh folder') : t('查看目录', 'Browse folder'), load, { disabled: loading })),
        error && h('p', { className: cls('error'), role: 'alert' }, error),
        list && hint(list.dir),
        list?.stickers.length === 0 && hint(t('将图片放入这个目录后即可选择。', 'Add images to this folder to use them here.')),
        list && h('div', { className: cls('list') }, ...list.stickers.map((sticker) =>
          h('div', { key: sticker.file, className: cls('list-row') },
            h('span', null, sticker.file),
            chosen === sticker.file ? actions(
              button(t('取消', 'Cancel'), () => setChosen(''), { disabled: loading }),
              button(t('确认发到「' + target + '」', 'Send to ' + target), async () => {
                setLoading(true)
                const sent = await run('/stickers/send', { file: sticker.file }, t('图片已发送', 'Image sent'))
                setLoading(false)
                if (sent) setChosen('')
              }, { tone: 'primary', disabled: loading }))
              : button(t('发送…', 'Send…'), () => setChosen(sticker.file), { disabled: !target || loading })))))
    }

    function Activity({ run, status }) {
      const [sessions, setSessions] = useState(null)
      const [diagnostics, setDiagnostics] = useState(null)
      const [pending, setPending] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const load = async (path, update) => {
        setBusy(true)
        setError('')
        try { update(await request(path)) }
        catch (failure) { setError(failure.message) }
        finally { setBusy(false) }
      }
      useEffect(() => { load('/sessions', setSessions) }, [])

      const sessionAction = async (action, sessionId) => {
        setBusy(true)
        const done = await run('/sessions', { action, sessionId }, t('会话已更新', 'Session updated'))
        setPending(null)
        if (done) await load('/sessions', setSessions)
        setBusy(false)
      }
      const injection = diagnostics?.injection
      const lastRead = diagnostics ? diagnostics.lastRead : status.lastRead
      const readReasons = {
        baseline: t('启动时记录可见消息', 'Startup baseline'),
        scan: t('定时巡检', 'Scheduled scan'),
        'manual-scan': t('手动巡检', 'Manual scan'),
        notification: t('补齐通知正文', 'Complete notification text'),
        tool: t('模型调用读屏工具', 'Model requested a chat read'),
      }
      const readSources = {
        copy: t('拖拽复制', 'Drag-copy'),
        ocr: 'OCR',
        'private-ocr': t('私聊 OCR', 'Private-chat OCR'),
        unavailable: t('读取失败', 'Read failed'),
      }
      return h('div', { className: cls('stack') },
        error && h('div', { className: cls('banner error'), role: 'alert' }, error),
        h('section', { className: cls('card') },
          h('div', { className: cls('toolbar') }, title(t('机器人会话', 'Bot sessions')),
            button(t('刷新列表', 'Refresh list'), () => load('/sessions', setSessions), { disabled: busy })),
          sessions?.sessions.length === 0 && hint(t('暂无机器人会话。', 'No bot sessions yet.')),
          sessions && h('div', { className: cls('list') }, ...sessions.sessions.map((row) =>
            h('div', { key: row.sessionId, className: cls('list-row') },
              h('div', null, row.createdAt ? new Date(row.createdAt).toLocaleString() : row.sessionId,
                hint(row.archived ? t('已归档', 'Archived') : t('未归档', 'Active'))),
              pending === row.sessionId ? actions(
                button(t('取消', 'Cancel'), () => setPending(null), { disabled: busy }),
                button(t('永久删除', 'Delete permanently'), () => sessionAction('remove', row.sessionId), { disabled: busy, tone: 'danger' }))
                : actions(
                  button(row.archived ? t('恢复', 'Restore') : t('归档', 'Archive'),
                    () => sessionAction(row.archived ? 'restore' : 'archive', row.sessionId), { disabled: busy }),
                  button(t('删除…', 'Delete…'), () => setPending(row.sessionId), { disabled: busy, tone: 'danger' })))))),
        h('section', { className: cls('card') },
          h('div', { className: cls('toolbar') }, title(t('诊断', 'Diagnostics')),
            button(t('读取诊断', 'Load diagnostics'), () => load('/diagnostics', setDiagnostics), { disabled: busy })),
          hint(t('记忆条目', 'Memory entries') + ' · ' + (status.memory ?? '—')),
          h('dl', { className: cls('detail') },
            h('dt', null, t('最近一次读屏', 'Last chat read')),
            h('dd', null, lastRead
              ? [readReasons[lastRead.reason], readSources[lastRead.source], new Date(lastRead.at).toLocaleTimeString()].filter(Boolean).join(' · ')
              : t('暂无记录', 'No reads yet')),
            lastRead?.issue && h('dt', null, t('读取详情', 'Read details')),
            lastRead?.issue && h('dd', null, lastRead.issue)),
          (status.lastError || status.trigger?.lastError) && h('p', { className: cls('error') }, status.lastError || status.trigger.lastError),
          injection && h('dl', { className: cls('detail') },
            h('dt', null, t('首轮文本', 'First-turn text')), h('dd', null, injection.first.length + ' / ' + injection.first.limit),
            h('dt', null, t('后续文本', 'Follow-up text')), h('dd', null, injection.joined.length + ' / ' + injection.joined.limit),
            h('dt', null, t('队列消息', 'Queued messages')), h('dd', null, diagnostics.inbox.count))))
    }

    function Overview({ status, busy, run, showSettings }) {
      const settings = status.settings
      const target = settings.expectedGroup
      const windowTitle = status.window?.title || (status.window ? t('微信窗口已找到', 'WeChat window found') : t('未找到窗口', 'No window found'))
      const values = [
        [t('已配置的聊天', 'Configured chat'), target || t('待设置', 'Not configured')],
        [t('聊天模式', 'Chat mode'), settings.chatMode === 'private' ? t('私聊', 'Private') : t('群聊', 'Group')],
        [t('当前微信窗口', 'Current WeChat window'), windowTitle],
        [t('DSH 会话通道', 'DSH session connection'), status.trigger?.available ? t('已就绪', 'Ready') : t('不可用', 'Unavailable')],
        [t('待处理消息', 'Pending messages'), status.detector?.queued ?? status.pending],
      ]
      return h('div', { className: cls('grid') },
        h(Preview, { attached: status.config.attachScreenshot }),
        h('div', { className: cls('stack') },
          h('section', { className: cls('card') },
            title(t('聊天与连接', 'Chat and connection')),
            h('dl', { className: cls('detail') }, ...values.flatMap(([label, value]) => [
              h('dt', { key: label }, label), h('dd', { key: label + '-value' }, value),
            ])),
            actions(
              button(target ? t('编辑设置', 'Edit settings') : t('设置目标聊天', 'Set target chat'), showSettings,
                { tone: target ? undefined : 'primary' }),
              button(t('打开独立聊天窗口', 'Open detached chat'), () => run('/window', {}, t('已打开聊天窗口', 'Chat window opened')),
                { disabled: busy || !target }))),
          h(Stickers, { target, run })))
    }

    function PanelBody() {
      const [tab, setTab] = useState('overview')
      const [status, setStatus] = useState(null)
      const [loading, setLoading] = useState(false)
      const [operation, setOperation] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [drafts, setDrafts] = useState({})

      const refresh = async (signal) => {
        setLoading(true)
        try {
          const result = await request('/status', { signal })
          if (!signal?.aborted) setStatus(result)
          return result
        } catch (failure) {
          if (!signal?.aborted) setError(failure.message)
          return null
        } finally { if (!signal?.aborted) setLoading(false) }
      }

      useEffect(() => {
        const active = new AbortController()
        refresh(active.signal)
        return () => active.abort()
      }, [])

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
        ['activity', t('会话与诊断', 'Sessions and diagnostics')],
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
              () => run('/detector', { action: 'scan' }, t('巡检完成', 'Scan complete')), { disabled: busy }),
            status && button(
              running ? t('停止', 'Stop') : t('启动', 'Start'),
              () => run('/detector', { action: running ? 'stop' : 'start' },
                running ? t('机器人已停止', 'Bot stopped') : t('机器人已启动', 'Bot started')),
              { disabled: busy || (!running && !status.settings.expectedGroup), tone: running ? undefined : 'primary' }))),
        h('nav', { className: cls('nav'), 'aria-label': t('微信机器人面板', 'WeChat bot panel') },
          ...nav.map(([value, label]) => h('button', {
            key: value, type: 'button', 'aria-pressed': tab === value, onClick: () => setTab(value),
          }, label))),
        error && h('div', { className: cls('banner error'), role: 'alert' }, error),
        notice && h('div', { className: cls('banner'), role: 'status' }, notice),
        status && tab === 'overview' && h(Overview, { status, busy, run, showSettings: () => setTab('settings') }),
        status && tab === 'settings' && h(Settings, { status, onSave: save, busy, drafts, setDrafts }),
        status && tab === 'activity' && h(Activity, { run, status }))
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
