#!/usr/bin/env node
/*
 * Keeps only the newest READY production deployment of the Vercel project and
 * deletes every other deployment (older production builds and any previews).
 *
 * Environment: VERCEL_TOKEN, VERCEL_PROJECT_ID, VERCEL_TEAM_ID (or VERCEL_ORG_ID).
 * Pass --dry-run to list what would be removed without deleting anything.
 *
 * Nothing is deleted unless a READY production deployment exists to keep.
 */
'use strict';

const API = 'https://api.vercel.com';
const token = process.env.VERCEL_TOKEN;
const projectId = process.env.VERCEL_PROJECT_ID;
const teamId = process.env.VERCEL_TEAM_ID || process.env.VERCEL_ORG_ID;
const dryRun = process.argv.includes('--dry-run');

if (!token || !projectId) {
  console.error('VERCEL_TOKEN and VERCEL_PROJECT_ID are required.');
  process.exit(1);
}

async function api(method, pathname, params = {}) {
  const url = new URL(API + pathname);
  for (const [key, value] of Object.entries({ ...params, teamId })) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function listDeployments() {
  const all = [];
  let until;
  do {
    const page = await api('GET', '/v6/deployments', { projectId, limit: 100, until });
    all.push(...page.deployments);
    until = page.pagination && page.pagination.next;
  } while (until);
  return all.sort((a, b) => b.created - a.created);
}

(async () => {
  const deployments = await listDeployments();
  const state = (d) => d.readyState || d.state;
  const keep = deployments.find((d) => d.target === 'production' && state(d) === 'READY');
  if (!keep) {
    console.log('No READY production deployment found - nothing deleted.');
    return;
  }
  const newest = deployments.find((d) => d.target === 'production');
  if (newest.uid !== keep.uid) {
    console.log(`Newest production deployment is ${state(newest)}, not READY - nothing deleted.`);
    return;
  }
  const doomed = deployments.filter((d) => d.uid !== keep.uid);
  console.log(`Keeping ${keep.url} (${new Date(keep.created).toISOString()}).`);
  console.log(`${dryRun ? 'Would delete' : 'Deleting'} ${doomed.length} other deployment(s).`);
  let failed = 0;
  for (const d of doomed) {
    const label = `${d.url} [${d.target || 'preview'}, ${state(d)}]`;
    if (dryRun) {
      console.log('  - ' + label);
      continue;
    }
    try {
      await api('DELETE', `/v13/deployments/${d.uid}`);
      console.log('  deleted ' + label);
    } catch (err) {
      failed += 1;
      console.error(`  FAILED ${label}: ${err.message}`);
    }
  }
  if (failed) process.exit(1);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
