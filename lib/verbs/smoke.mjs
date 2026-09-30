// smoke verb
import { defineVerb } from './registry.mjs';
import { runSmoke } from '../modules/smoke.mjs';

defineVerb({
  name: 'smoke', group: 'smoke',
  desc: 'AUTOMATIC SMOKE TEST: discover a GUI script\'s controls/menus/hotkeys/timers, poke everything (skipping dangerous-looking things), catch errors/dialogs/hangs/leaks. Hidden desktop + shadow copy.',
  args: {
    script: { type: 'string', positional: 0, required: true, desc: 'AHK v2 script to smoke-test' },
    level: { type: 'string', default: 'poke', desc: 'static | boot | discover | poke' },
    budget: { type: 'number', default: 60, desc: 'total seconds' },
    maxActions: { type: 'number', default: 150 },
    seed: { type: 'number', default: 1, desc: 'random seed (same seed = same action order)' },
    fuzz: { type: 'number', default: 4, desc: 'fuzz strings per edit control' },
    deny: { type: 'string', desc: 'regex of control/menu labels never to touch (default: delete|remove|format|send|...)' },
    allow: { type: 'string', desc: 'regex of labels exempt from the deny-list' },
    unsafe: { type: 'boolean', desc: 'do NOT stub destructive APIs (FileDelete, RegWrite, Run ...)' },
    inPlace: { type: 'boolean', desc: 'run the original folder instead of a shadow copy (writes to A_ScriptDir hit the real files)' },
    patch: { type: 'array', desc: 'extra patch recipes' },
    args: { type: 'array', desc: 'script arguments' },
    noHotkeys: { type: 'boolean' },
    noLsp: { type: 'boolean', desc: 'skip the language-server static pass' },
    noKeepGoing: { type: 'boolean', desc: 'end the run at the first AHK error dialog' },
    label: { type: 'string' },
  },
  async run(ctx, a) {
    return runSmoke(ctx, { ...a, keepGoing: !a.noKeepGoing, lsp: !a.noLsp });
  },
});
