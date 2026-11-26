import { createHash } from 'node:crypto'

export function chatName(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s*\(\d+\)\s*$/, '').trim()
}

export function configuredTargets(config) {
  const legacy = String(config.expectedGroup ?? '').trim()
  const rows = config.targets ?? (legacy ? [{ name: legacy, mode: config.chatMode ?? 'group' }] : [])
  if (!Array.isArray(rows) || rows.length > 10) throw new Error('最多配置 10 个聊天')
  const names = new Set()
  const ids = new Set()
  return rows.map((row) => {
    const name = typeof row?.name === 'string' ? row.name.trim() : ''
    const key = chatName(name)
    if (!key || name.length > 160 || !['group', 'private', 'clawbot'].includes(row.mode)) {
      throw new Error('请填写有效的聊天名称和模式')
    }
    if (names.has(key)) throw new Error(`无法区分同名聊天「${name}」`)
    if (row.mode === 'clawbot') {
      const accountId = typeof row.accountId === 'string' ? row.accountId.trim() : ''
      if (!/^[A-Za-z0-9_.-]{1,120}$/.test(accountId)) throw new Error(`官方私聊「${name}」缺少有效的扫码绑定账号`)
      const userId = typeof row.userId === 'string' ? row.userId.trim() : ''
      const role = row.role === 'admin' ? 'admin' : 'chat'
      const workspacePath = typeof row.workspacePath === 'string' ? row.workspacePath.trim() : ''
      const id = createHash('sha256').update(`clawbot:${accountId}:${userId || key}`).digest('hex').slice(0, 20)
      if (ids.has(id)) throw new Error('聊天标识冲突')
      names.add(key)
      ids.add(id)
      return {
        id,
        name,
        mode: 'clawbot',
        accountId,
        role,
        ...(workspacePath ? { workspacePath } : {}),
        ...(userId ? { userId } : {}),
      }
    }
    const id = createHash('sha256').update(key).digest('hex').slice(0, 20)
    if (ids.has(id)) throw new Error('聊天标识冲突')
    names.add(key)
    ids.add(id)
    return { id, name, mode: row.mode }
  })
}
