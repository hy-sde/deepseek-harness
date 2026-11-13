/** Reader-compat declarations for persisted webhook message sources, kept after the producer left this fork. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identifies one programmatic webhook rule. */
export type WebhookRuleId = Branded<'WebhookRuleId'>

/** Identifies one configured webhook adapter instance. */
export type WebhookSourceId = Branded<'WebhookSourceId'>

/** Identifies one provider delivery. The runtime assigns no deduplication semantics. */
export type WebhookDeliveryId = Branded<'WebhookDeliveryId'>

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Programmatic input admitted from one verified webhook rule. */
    webhook: {
      readonly kind: 'webhook'
      readonly provider: string
      readonly source: WebhookSourceId
      readonly deliveryId: WebhookDeliveryId
      readonly ruleId: WebhookRuleId
      readonly form: 'notice'
      readonly summary: string
    }
  }
}
