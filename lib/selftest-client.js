#!/usr/bin/env node
/**
 * Self-test for the *client* bundle: loads `lib/client.js` the way the web GUI
 * does (a classic script calling `window.__ModuleLoader__.load`) and asserts the
 * slot contract.
 *
 * This is the test that would have caught the 0.1.3 bug where the contribution
 * was registered under the plugin name instead of the slot name — that is a
 * load-time throw in the real GUI (`slot "agent-manager" is not declared`) and
 * an invisible button everywhere else.
 *
 * Usage: node lib/selftest-client.js
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SLOT = 'conversation.session.header.actions';
const here = path.dirname(fileURLToPath(import.meta.url));

/* ----------------------------------------------------------- react stub */
const state = [];
const fakeReact = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => {
    state.push(initial);
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useRef: (initial) => ({ current: initial ?? null }),
  useCallback: (fn) => fn,
  useEffect: () => undefined,
};

const modules = { react: fakeReact };
const requireStub = (id) => {
  if (id in modules) return modules[id];
  throw new Error(`unexpected require(${JSON.stringify(id)}) — client bundle may only use injected packages`);
};

/* ------------------------------------------------------- loader harness */
let exported = null;
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      assert.equal(id, 'dsh-agent-manager', `bundle id must match the boot entry, got ${id}`);
      exported = factory(requireStub);
    },
  },
};

const source = fs.readFileSync(path.join(here, 'client.js'), 'utf8');
new Function('window', source)(globalThis.window);

assert.ok(exported !== null, 'bundle did not call __ModuleLoader__.load');
assert.equal(typeof exported.apply, 'function', 'bundle must export apply()');
assert.deepEqual(exported.inject, ['slots'], 'bundle must declare the slots service');
assert.equal(typeof exported.AgentManagerAction, 'function', 'bundle must export the component (debug aid)');

/* ----------------------------------------------------------- apply(ctx) */
const registrations = [];
const injected = [];
const ctx = {
  slots: {
    inject(slot, cb) {
      injected.push(slot);
      cb();
    },
    register(descriptor, Component) {
      registrations.push({ descriptor, Component });
      return () => {};
    },
  },
};

exported.apply(ctx);

assert.deepEqual(injected, [SLOT], `apply must inject ${SLOT}, got ${JSON.stringify(injected)}`);
assert.equal(registrations.length, 1, 'apply must register exactly one contribution');
const { descriptor, Component } = registrations[0];
assert.equal(descriptor.name, SLOT, `descriptor.name is the slot being contributed to, got ${descriptor.name}`);
assert.equal(descriptor.id, 'agent-manager:header-action', 'descriptor.id names this contribution');
assert.equal(typeof descriptor.order, 'number', 'descriptor.order must be numeric');
assert.equal(typeof Component, 'function', 'a component must be registered');

/* ------------------------------------------------- smoke-render the button */
let element = null;
try {
  element = Component({ sessionId: 'session-smoke' });
} catch (error) {
  assert.fail(`component threw while rendering with a sessionId: ${error}`);
}
assert.ok(element !== null, 'component must render something when a session is open');

// A session object instead of a bare id must work too (prop spelling has varied).
assert.ok(Component({ session: { id: 'session-smoke' } }) !== null, 'session.id fallback must render');

// With no session at all there is nothing to manage: rendering nothing is the
// documented behaviour (the header slot always belongs to a session anyway).
assert.equal(Component({}), null, 'no sessionId and no session → render nothing');

process.stdout.write(
  `selftest-client: all assertions passed (slot ${SLOT}, id ${descriptor.id}, order ${descriptor.order})\n`,
);
