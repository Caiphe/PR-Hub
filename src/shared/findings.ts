import { z } from 'zod'

// The structured block the reviewer appends to its markdown. See PLAN.md "Findings JSON contract".
// Lenient where the model is likely to wobble (missing optional fields, null line numbers),
// strict on the fields the UI and GitHub posting depend on.

export const SEVERITIES = ['blocking', 'should_fix', 'nit'] as const
export const VERDICTS = ['approve', 'approve_with_suggestions', 'request_changes'] as const

export const FindingSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(SEVERITIES),
  title: z.string().min(1),
  file: z.string().nullish(),
  line: z.number().int().positive().nullish(),
  body: z.string().default(''),
  suggestion: z.string().nullish(),
  /** Incremental reviews: the id of the previous review's finding this one continues. */
  previous_id: z.string().nullish()
})

export const RequirementSchema = z.object({
  text: z.string().min(1),
  status: z.enum(['done', 'partial', 'missing']),
  notes: z.string().nullish()
})

/** Incremental reviews: the model's classification of each finding from the previous review. */
export const PreviousFindingSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['still_present', 'resolved', 'unable_to_verify']),
  evidence: z.string().nullish()
})

export const FindingsSchema = z.object({
  verdict: z.enum(VERDICTS),
  summary: z.string().default(''),
  requirements: z.array(RequirementSchema).default([]),
  findings: z.array(FindingSchema).default([]),
  // Optional, and a malformed list is dropped rather than costing the whole findings block:
  // every previous finding then shows as "Unable to verify".
  previous_findings: z.array(PreviousFindingSchema).optional().catch(undefined)
})

export type Finding = z.infer<typeof FindingSchema>
export type Requirement = z.infer<typeof RequirementSchema>
export type Findings = z.infer<typeof FindingsSchema>
export type PreviousFinding = z.infer<typeof PreviousFindingSchema>
