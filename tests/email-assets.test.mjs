import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serveEmailAsset } from '../worker/email/assets.ts'

test('public image route caches artwork, supports HEAD and revalidation, and exposes no templates', async () => {
 let reads = 0; const pending = []; const stored = new Map()
 const cache = { match: async request => stored.get(request.url)?.clone(), put: async (request, response) => { stored.set(request.url, response) } }
 const bucket = { get: async key => { reads++; assert.equal(key, 'assets/header.png'); return { body: new Uint8Array([1,2,3]), httpEtag: '"png-test"' } } }
 const ctx = { waitUntil: p => pending.push(p) }
 const url = 'https://api.fonteslabs.com/email-assets/header.png'
 const first = await serveEmailAsset(new Request(url), bucket, ctx, cache)
 assert.equal(first.headers.get('Content-Type'), 'image/png')
 assert.equal(first.headers.get('Cache-Control'), 'public, max-age=300')
 assert.deepEqual(new Uint8Array(await first.arrayBuffer()), new Uint8Array([1,2,3]))
 await Promise.all(pending)
 const head = await serveEmailAsset(new Request(url, { method: 'HEAD' }), bucket, ctx, cache)
 assert.equal(await head.text(), '')
 assert.equal(reads, 1)
 assert.equal((await serveEmailAsset(new Request(url, { headers: { 'If-None-Match': '"png-test"' } }), bucket, ctx, cache)).status, 304)
 assert.equal((await serveEmailAsset(new Request(url, { method: 'POST' }), bucket, ctx, cache)).status, 405)
 assert.equal((await serveEmailAsset(new Request('https://api.fonteslabs.com/email-assets/sign-in.json'), bucket, ctx, cache)).status, 404)
 assert.equal(reads, 1)
})
