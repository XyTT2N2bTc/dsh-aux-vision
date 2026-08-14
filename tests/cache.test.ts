import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createTtlCache } from '../src/cache.js'

describe('createTtlCache', () => {
  it('stores and reads values', () => {
    const cache = createTtlCache(10, 1000)
    cache.set('a', '1')
    assert.equal(cache.get('a'), '1')
    assert.equal(cache.get('missing'), undefined)
  })

  it('expires entries after ttl', async () => {
    const cache = createTtlCache(10, 30)
    cache.set('a', '1')
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(cache.get('a'), undefined)
  })

  it('evicts the least-recently-used entry at capacity', () => {
    const cache = createTtlCache(2, 60_000)
    cache.set('a', '1')
    cache.set('b', '2')
    cache.get('a') // touch a → b becomes LRU
    cache.set('c', '3')
    assert.equal(cache.get('b'), undefined)
    assert.equal(cache.get('a'), '1')
    assert.equal(cache.get('c'), '3')
  })

  it('replaces an existing key and moves it to the end', () => {
    const cache = createTtlCache(2, 60_000)
    cache.set('a', '1')
    cache.set('b', '2')
    cache.set('a', '1b')
    cache.set('c', '3') // b is now LRU
    assert.equal(cache.get('a'), '1b')
    assert.equal(cache.get('b'), undefined)
  })

  it('reports size', () => {
    const cache = createTtlCache(10, 1000)
    cache.set('a', '1')
    cache.set('b', '2')
    assert.equal(cache.size, 2)
  })
})
