/**
 * Prompt-injection detection for chat text.
 *
 * Group messages are untrusted third-party input. This flags phrasings that try
 * to steer the agent rather than talk to it, so the caller can surface them as a
 * warning instead of treating the text as an instruction.
 */

const INJECTION_PATTERNS = [
  /忘(?:掉|记)一切(?:上下文|设定|指令)/,
  /忽略(?:之前|以上|上面|前面)的?(?:所有)?(?:指令|设定|提示|规则)/,
  /ignore (?:all )?(?:previous|above|prior) (?:instructions?|prompts?|rules?)/i,
  /disregard (?:all )?(?:previous|above|prior)/i,
  /你(?:现在|从此)(?:是|就是)我(?:的)?主人/,
  /you are (?:now )?my (?:master|owner)/i,
  /(?:系统|system)\s*[:：]\s*你(?:现在|将)/,
  /从现在(?:开始|起)[，,]?\s*你(?:是|就是|要|必须|不能)/,
  /(?:执行|运行|调用|删除|rm -rf|curl .*\|.*sh).{0,12}(?:命令|脚本|tool|工具)/i,
  /(?:api[_\s-]?key|token|密码|密钥|secret).{0,10}(?:发给|发我|告诉我|输出|打印|贴出)/i,
  // Obfuscated credential requests: a prefix or a config path plus "send it to me".
  // Real attempts avoid the words above precisely to slip past keyword filters.
  /(?:config|配置|\.env|环境变量).{0,16}(?:发给|发我|贴|输出|打印|找一段|找段)/i,
  /[a-z]{3,6}_[a-z0-9]{3,}.{0,12}(?:发我|发给我|贴)/i,
  /(?:开头|前缀).{0,10}(?:字符串|的key|的串).{0,10}(?:发我|发给我)/,
  /(?:无限|一直|循环).{0,8}(?:输出|刷屏|回复)/,
]

/** True when the text looks like an attempt to steer the agent. */
export function looksLikeInjection(text) {
  const line = String(text || '')
  return INJECTION_PATTERNS.some((re) => re.test(line))
}

/** Flag every message whose text looks like an injection attempt. */
export function scanForInjection(messages) {
  const flagged = []
  for (const msg of messages || []) {
    if (looksLikeInjection(msg.content)) {
      flagged.push({ sender: msg.sender, content: msg.content })
    }
  }
  return flagged
}
