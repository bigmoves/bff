/**
 * GENERATED CODE - DO NOT MODIFY
 */
import { type ValidationResult, BlobRef } from '@atproto/lexicon'
import { CID } from 'multiformats/cid'
import { validate as _validate } from '../../../lexicons.ts'
import { type $Typed, is$typed as _is$typed, type OmitKey } from '../../../util.ts'

const is$typed = _is$typed,
  validate = _validate
const id = 'sh.tangled.repo'

export interface Record {
  $type: 'sh.tangled.repo'
  /** name of the repo */
  name: string
  owner: string
  /** knot where the repo was created */
  knot: string
  addedAt?: string
  description?: string
  /** source of the repo */
  source?: string
  [k: string]: unknown
}

const hashRecord = 'main'

export function isRecord<V>(v: V) {
  return is$typed(v, id, hashRecord)
}

export function validateRecord<V>(v: V) {
  return validate<Record & V>(v, id, hashRecord, true)
}
