-- Server-authoritative, fixed-step simulation. No timers or client timestamps.
-- Direction: 0 east, 1 south, 2 west, 3 north. Coordinates are zero-based.
local SIZE, STEP_MS, COUNTDOWN_MS, STALE_MS = 40, 120, 3000, 1800
local DX, DY = { 1, 0, -1, 0 }, { 0, 1, 0, -1 }

local function reject(code, message)
  return { accepted = false, error = { code = code, message = message } }
end

local function accept(state)
  return { accepted = true, state = state, events = {} }
end

local function cell(x, y) return y * SIZE + x + 1 end

local function occupied(state, x, y)
  if x < 0 or y < 0 or x >= SIZE or y >= SIZE then return true end
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
  for y = 1, SIZE do state.board[y] = string.rep("0", SIZE) end
  for i, p in ipairs(state.players) do
    p.x, p.y, p.dir = i == 1 and 9 or 30, i == 1 and 19 or 20, i == 1 and 0 or 2
    p.turn, p.lastSeen, p.ready, p.rematch, p.crashed = 0, 0, false, false, false
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
    p.dir = (p.dir + p.turn + 4) % 4
    p.turn = 0
    nexts[i] = { x = p.x + DX[p.dir + 1], y = p.y + DY[p.dir + 1] }
    nexts[i].hit = occupied(state, nexts[i].x, nexts[i].y)
  end
  -- Evaluate both moves against the SAME board; neither seat has priority.
  if nexts[1].x == nexts[2].x and nexts[1].y == nexts[2].y then
    nexts[1].hit, nexts[2].hit = true, true
  end
  state.tick = state.tick + 1
  for i, p in ipairs(state.players) do
    p.crashed = nexts[i].hit
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
      for _, p in ipairs(state.players) do p.turn = 0 end
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
    for _, p in ipairs(state.players) do p.turn = 0 end
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
  local state = { size = SIZE, stepMs = STEP_MS, round = 0, players = {} }
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
  if type(action) ~= "table" or (action.type ~= "pulse" and action.type ~= "turn" and action.type ~= "rematch") then
    return reject("INVALID_ACTION", "Expected pulse, turn or rematch")
  end
  if action.round ~= state.round then return reject("STALE_ROUND", "This round has already ended") end
  if action.type == "turn" and action.direction ~= -1 and action.direction ~= 1 then
    return reject("INVALID_TURN", "Direction must be -1 or 1")
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
  if action.type == "turn" and (state.phase == "playing" or state.phase == "countdown") then
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
      dir = p.dir, trail = p.trail, crashed = p.crashed, rematch = p.rematch,
      turn = p.id == context.viewer.id and p.turn or 0 }
  end
  return { state = { size = state.size, stepMs = state.stepMs, round = state.round,
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
