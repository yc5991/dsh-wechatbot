import Schema from '@deepseek-ai/schemastery'

/** Register a preset through DSH while exposing its own component metadata. */
async function declareAgentPreset(ctx, config) {
  return ctx.agentPresets.register(config)
}

declareAgentPreset.inject = ['agentPresets']
// Cordis evaluates child plugin expressions in their own contexts.
declareAgentPreset[Symbol.for('cordis.group')] = true
declareAgentPreset.Config = Schema.object({
  id: Schema.string().required(),
  name: Schema.string(),
  description: Schema.string(),
  order: Schema.number(),
  plugins: Schema.array(Schema.any()).required(),
})

export default declareAgentPreset
