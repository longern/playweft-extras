-- Server-authoritative, fixed-step simulation. No timers or client timestamps.
-- Direction: 0 east, 1 south, 2 west, 3 north. Coordinates are zero-based.
local WIDTH, HEIGHT, STEP_MS, COUNTDOWN_MS, STALE_MS = 48, 27, 120, 3000, 1800
local DX, DY = { 1, 0, -1, 0 }, { 0, 1, 0, -1 }

local function reject(code, message)
  return { accepted = false, error = { code = code, message = message } }
end

local function accept(state)
  return { accepted = true, state = state, events = {} }
end

local function cell(x, y) return y * WIDTH + x + 1 end

local function occupied(state, x, y)
  if x < 0 or y < 0 or x >= WIDTH or y >= HEIGHT then return true end
  return string.sub(state.board[y + 1], x + 1, x + 1) ~= "0"
end

local function paint(state, player, index)
  local row = state.board[player.y + 1]
  state.board[player.y + 1] = string.sub(row, 1, player.x) .. tostring(index)
    .. string.sub(row, player.x + 2)
  table.insert(player.trail, cell(player.x, player.y))
end

local function new_round(state, now)
  state.round = state.round + 1
  state.phase, state.reason, state.winner = "waiting", "", 0
  state.startsAt, state.lastStepAt, state.tick = 0, now, 0
  state.board = {}
  for y = 1, HEIGHT do state.board[y] = string.rep("0", WIDTH) end
  for i, p in ipairs(state.players) do
    p.x, p.y, p.dir = i == 1 and 11 or 36, i == 1 and 12 or 14, i == 1 and 0 or 2
    p.turn, p.lastSeen, p.ready, p.rematch, p.crashed = 0, 0, false, false, false
    p.inputSeq, p.appliedSeq, p.inputs = 0, 0, {}
    p.impact = nil
    p.trail = {}
    paint(state, p, i)
  end
end

local function finish(state, winner, reason)
  state.phase, state.winner, state.reason = "ended", winner, reason
  if winner > 0 then state.players[winner].score = state.players[winner].score + 1 end
end

local function step(state)
  local nexts = {}
  for i, p in ipairs(state.players) do
    local input = p.inputs and p.inputs[1]
    if input and input.tick <= state.tick + 1 then
      table.remove(p.inputs, 1)
      if (input.heading - p.dir + 4) % 4 ~= 2 then p.dir = input.heading end
      p.appliedSeq = input.seq
      p.turn = 0
    end
    p.dir = (p.dir + p.turn + 4) % 4
    p.turn = 0
    nexts[i] = { x = p.x + DX[p.dir + 1], y = p.y + DY[p.dir + 1] }
    local n = nexts[i]
    n.hit = occupied(state, n.x, n.y)
    if n.hit then
      local wall = n.x < 0 or n.y < 0 or n.x >= WIDTH or n.y >= HEIGHT
      n.kind = wall and "wall" or "trail"
      n.owner = wall and 0 or tonumber(string.sub(state.board[n.y + 1], n.x + 1, n.x + 1))
    end
  end
  -- Evaluate both moves against the SAME board; neither seat has priority.
  if nexts[1].x == nexts[2].x and nexts[1].y == nexts[2].y then
    nexts[1].hit, nexts[2].hit = true, true
    nexts[1].kind, nexts[2].kind = "head", "head"
    nexts[1].owner, nexts[2].owner = 2, 1
  elseif nexts[1].x == state.players[2].x and nexts[1].y == state.players[2].y
    and nexts[2].x == state.players[1].x and nexts[2].y == state.players[1].y then
    nexts[1].kind, nexts[2].kind = "head", "head"
    nexts[1].owner, nexts[2].owner = 2, 1
  end
  state.tick = state.tick + 1
  for i, p in ipairs(state.players) do
    p.crashed = nexts[i].hit
    if p.crashed then
      local n = nexts[i]
      p.impact = { tick = state.tick, at = state.lastStepAt, fromX = p.x, fromY = p.y,
        x = n.x, y = n.y, kind = n.kind, owner = n.owner }
    end
    if not p.crashed then
      p.x, p.y = nexts[i].x, nexts[i].y
      paint(state, p, i)
    end
  end
  if nexts[1].hit or nexts[2].hit then
    local winner = 0
    if not nexts[1].hit then winner = 1 end
    if not nexts[2].hit then winner = 2 end
    finish(state, winner, "collision")
  end
end

local function both_present(state, now)
  for _, p in ipairs(state.players) do
    if not p.ready or now - p.lastSeen > STALE_MS then return false end
  end
  return true
end

local function advance(state, now)
  if state.phase == "ended" or state.phase == "closed" then return end
  if not both_present(state, now) then
    if state.phase ~= "waiting" then
      state.phase, state.reason = "paused", "connection"
      for _, p in ipairs(state.players) do p.turn, p.inputs = 0, {}; p.appliedSeq = p.inputSeq end
    end
    return
  end
  if state.phase == "waiting" or state.phase == "paused" then
    state.phase, state.reason, state.startsAt = "countdown", "", now + COUNTDOWN_MS
    state.lastStepAt = state.startsAt
    return
  end
  if state.phase == "countdown" then
    if now < state.startsAt then return end
    state.phase = "playing"
  end
  -- A stalled room resumes with a countdown instead of replaying a lethal burst.
  if now - state.lastStepAt > STEP_MS * 8 then
    state.phase, state.startsAt, state.lastStepAt = "countdown", now + COUNTDOWN_MS, now + COUNTDOWN_MS
    for _, p in ipairs(state.players) do p.turn, p.inputs = 0, {}; p.appliedSeq = p.inputSeq end
    return
  end
  local count = 0
  while state.phase == "playing" and now >= state.lastStepAt + STEP_MS and count < 8 do
    state.lastStepAt = state.lastStepAt + STEP_MS
    step(state)
    count = count + 1
  end
end

function setup(context)
  assert(#context.players == 2, "Light Trails requires exactly two players")
  local state = { width = WIDTH, height = HEIGHT, stepMs = STEP_MS, round = 0, players = {} }
  for i, p in ipairs(context.players) do
    state.players[i] = { id = p.id, name = p.name or ("Player " .. i), score = 0 }
  end
  new_round(state, context.serverTime or context.match.startedAt)
  return { state = state, events = {} }
end

function on_action(state, action, context)
  local index = 0
  for i, p in ipairs(state.players) do if p.id == context.actor.id then index = i end end
  if index == 0 or context.actor.role == "spectator" then
    return reject("SPECTATOR", "Spectators cannot control the game")
  end
  if type(action) ~= "table" or (action.type ~= "pulse" and action.type ~= "turn" and action.type ~= "steer" and action.type ~= "rematch") then
    return reject("INVALID_ACTION", "Expected pulse, turn or rematch")
  end
  if action.round ~= state.round then return reject("STALE_ROUND", "This round has already ended") end
  if action.type == "turn" and action.direction ~= -1 and action.direction ~= 1 then
    return reject("INVALID_TURN", "Direction must be -1 or 1")
  end
  if action.type == "steer" then
    if type(action.heading) ~= "number" or action.heading % 1 ~= 0 or action.heading < 0 or action.heading > 3
      or type(action.seq) ~= "number" or action.seq % 1 ~= 0 or action.seq < 1 or action.seq > 1000000000
      or type(action.tick) ~= "number" or action.tick % 1 ~= 0 or action.tick < 1 or action.tick > 1000000000 then
      return reject("INVALID_INPUT", "Expected a heading, sequence and target tick")
    end
    if state.phase ~= "playing" and state.phase ~= "countdown" then return reject("NOT_ACTIVE", "Inputs require an active round") end
  end
  if state.phase == "closed" then return reject("PLAYER_LEFT", "Return to the room to find another player") end
  if action.type == "rematch" and state.phase ~= "ended" then
    return reject("ROUND_ACTIVE", "The round is still active")
  end
  local now = context.actionAt or context.serverTime
  local player = state.players[index]
  -- Detect a long silence BEFORE refreshing the returning player's timestamp.
  advance(state, now)
  player.lastSeen, player.ready = now, true
  advance(state, now)
  if action.type == "steer" then
    if state.phase ~= "playing" and state.phase ~= "countdown" then return reject("NOT_ACTIVE", "Round is no longer active") end
    if action.seq <= player.inputSeq then return accept(state) end
    if #player.inputs >= 6 then return reject("INPUT_QUEUE_FULL", "At most six queued inputs") end
    local previous = player.inputs[#player.inputs]
    local earliest = math.max(state.tick + 1, previous and previous.tick + 1 or 0)
    local target = math.max(earliest, math.min(action.tick, state.tick + 6))
    if target > state.tick + 6 then return reject("INPUT_QUEUE_FULL", "Input window is full") end
    player.inputSeq = action.seq
    table.insert(player.inputs, { seq = action.seq, tick = target, heading = action.heading })
  elseif action.type == "turn" and (state.phase == "playing" or state.phase == "countdown") then
    -- One queued quarter-turn per simulation step. Repeated taps cannot reverse.
    if player.turn == 0 then player.turn = action.direction end
  elseif action.type == "rematch" then
    player.rematch = true
    if state.players[1].rematch and state.players[2].rematch then new_round(state, now) end
  end
  return accept(state)
end

function view(state, events, context)
  local players = {}
  for i, p in ipairs(state.players) do
    players[i] = { id = p.id, name = p.name, score = p.score, x = p.x, y = p.y,
      dir = p.dir, trail = p.trail, crashed = p.crashed, impact = p.impact, rematch = p.rematch,
      turn = p.id == context.viewer.id and p.turn or 0,
      inputSeq = p.id == context.viewer.id and p.inputSeq or 0,
      appliedSeq = p.id == context.viewer.id and p.appliedSeq or 0,
      inputs = p.id == context.viewer.id and p.inputs or {} }
  end
  return { state = { width = state.width, height = state.height, stepMs = state.stepMs, round = state.round,
    phase = state.phase, reason = state.reason, winner = state.winner, tick = state.tick,
    startsAt = state.startsAt, lastStepAt = state.lastStepAt, players = players }, events = {} }
end

function on_player_left(state, context)
  for i, p in ipairs(state.players) do
    if p.id == context.actor.id then
      if state.phase ~= "ended" and state.phase ~= "closed" then finish(state, 3 - i, "player_left") end
      state.phase, state.reason = "closed", "player_left"
      break
    end
  end
  return { state = state, events = {} }
end

function on_return_to_room(state, context) return true end
