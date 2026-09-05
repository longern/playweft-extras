import { readFile } from 'node:fs/promises';
import { LuaFactory } from 'wasmoon';

// Development/test adapter only. Production Lua is executed by Playweft.
export function luaValue(value) {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') {
    return '"' + [...Buffer.from(value)].map((byte) => `\\${String(byte).padStart(3, '0')}`).join('') + '"';
  }
  if (Array.isArray(value)) return `{${value.map(luaValue).join(',')}}`;
  if (typeof value === 'object') return `{${Object.entries(value).map(([k, v]) => `[${luaValue(k)}]=${luaValue(v)}`).join(',')}}`;
  throw new Error('Non-JSON Lua input');
}

export async function createRuntime() {
  const engine = await new LuaFactory().createEngine();
  const source = await readFile(new URL('../games/light-trails/game.lua', import.meta.url), 'utf8');
  engine.doStringSync(`
    local hook = debug.sethook
    local function quote(value)
      return '"' .. string.gsub(value, '[%z\\1-\\31\\\\"]', function(char)
        if char == '"' then return '\\\\"' end
        if char == '\\\\' then return '\\\\\\\\' end
        return string.format('\\\\u%04x', string.byte(char))
      end) .. '"'
    end
    function __json(value)
      if type(value) == 'nil' then return 'null' end
      if type(value) == 'boolean' or type(value) == 'number' then return tostring(value) end
      if type(value) == 'string' then return quote(value) end
      local out = {}
      if #value > 0 then
        for i = 1, #value do out[i] = __json(value[i]) end
        return '[' .. table.concat(out, ',') .. ']'
      end
      for key, item in pairs(value) do table.insert(out, quote(key) .. ':' .. __json(item)) end
      return '{' .. table.concat(out, ',') .. '}'
    end
    function __begin_budget()
      local fuel = 0
      hook(function() fuel = fuel + 1000; if fuel > 50000 then error('instruction quota exceeded') end end, '', 1000)
    end
    function __end_budget() hook() end
    debug=nil; io=nil; os=nil; package=nil; require=nil; coroutine=nil;
    math.random=nil; math.randomseed=nil
    ${source}
  `);
  engine.global.setTop(0);
  return {
    async call(name, ...args) {
      if (!['setup', 'on_action', 'view', 'on_player_left', 'on_return_to_room'].includes(name)) throw new Error('Unknown callback');
      try {
        const result = engine.doStringSync(`__begin_budget(); local result = ${name}(${args.map(luaValue).join(',')}); __end_budget(); return __json(result)`);
        return JSON.parse(result);
      } finally {
        engine.global.setTop(0);
      }
    },
    close() { engine.global.close(); },
  };
}
