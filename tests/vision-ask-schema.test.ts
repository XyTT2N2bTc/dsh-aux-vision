import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { visionAskParameters } from '../src/vision-ask-schema.js'

describe('visionAskParameters', () => {
  it('uses JSON Schema object-level required fields', () => {
    assert.deepEqual(visionAskParameters.required, ['question'])
    assert.equal('required' in visionAskParameters.properties.question, false)
  })
})
