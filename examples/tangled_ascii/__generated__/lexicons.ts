/**
 * GENERATED CODE - DO NOT MODIFY
 */
import {
  type LexiconDoc,
  Lexicons,
  ValidationError,
  type ValidationResult,
} from '@atproto/lexicon'
import { type $Typed, is$typed, maybe$typed } from './util.ts'

export const schemaDict = {
  ShTangledRepo: {
    lexicon: 1,
    id: 'sh.tangled.repo',
    defs: {
      main: {
        type: 'record',
        key: 'tid',
        record: {
          type: 'object',
          required: ['name', 'knot', 'owner'],
          properties: {
            name: {
              type: 'string',
              description: 'name of the repo',
            },
            owner: {
              type: 'string',
              format: 'did',
            },
            knot: {
              type: 'string',
              description: 'knot where the repo was created',
            },
            addedAt: {
              type: 'string',
              format: 'datetime',
            },
            description: {
              type: 'string',
              format: 'datetime',
              minLength: 1,
              maxLength: 140,
            },
            source: {
              type: 'string',
              format: 'uri',
              description: 'source of the repo',
            },
          },
        },
      },
    },
  },
  ShTangledFeedStar: {
    lexicon: 1,
    id: 'sh.tangled.feed.star',
    defs: {
      main: {
        type: 'record',
        key: 'tid',
        record: {
          type: 'object',
          required: ['createdAt', 'subject'],
          properties: {
            createdAt: {
              type: 'string',
              format: 'datetime',
            },
            subject: {
              type: 'string',
              format: 'at-uri',
            },
          },
        },
      },
    },
  },
} as const satisfies Record<string, LexiconDoc>
export const schemas = Object.values(schemaDict) satisfies LexiconDoc[]
export const lexicons: Lexicons = new Lexicons(schemas)

export function validate<T extends { $type: string }>(
  v: unknown,
  id: string,
  hash: string,
  requiredType: true,
): ValidationResult<T>
export function validate<T extends { $type?: string }>(
  v: unknown,
  id: string,
  hash: string,
  requiredType?: false,
): ValidationResult<T>
export function validate(
  v: unknown,
  id: string,
  hash: string,
  requiredType?: boolean,
): ValidationResult {
  return (requiredType ? is$typed : maybe$typed)(v, id, hash)
    ? lexicons.validate(`${id}#${hash}`, v)
    : {
        success: false,
        error: new ValidationError(
          `Must be an object with "${hash === 'main' ? id : `${id}#${hash}`}" $type property`,
        ),
      }
}

export const ids = {
  ShTangledRepo: 'sh.tangled.repo',
  ShTangledFeedStar: 'sh.tangled.feed.star',
} as const
