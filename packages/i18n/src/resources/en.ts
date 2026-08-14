// English resource bundle. This module is the single source of truth for the
// key shape: `TranslationResource` is derived from it and Spanish is typed
// against it, so a missing or extra Spanish key is a compile error instead of
// a runtime fallback.
//
// Machine identifiers (role ids, action ids, event kinds, error codes,
// statuses) appear only as object keys — the exact values from
// @werewolf/protocol — and are never translated; only their presentation is.
// Values are i18next templates: `{{var}}` placeholders are filled by the
// caller, and `count_one` / `count_other` are i18next plural forms resolved
// per language.

export const en = {
  roles: {
    villager: {
      name: "Villager",
      description: "No special powers: hunt the wolves with votes and deduction alone.",
    },
    werewolf: {
      name: "Werewolf",
      description: "Attacks one villager each night; your pack wins by outnumbering the village.",
    },
    mason: {
      name: "Mason",
      description: "Knows who the other masons are and can trust them.",
    },
    seer: {
      name: "Seer",
      description: "Inspects one player each night and learns their role.",
    },
    cursed: {
      name: "Cursed Villager",
      description: "A villager who is turned into a werewolf if the wolves attack them.",
    },
    harlot: {
      name: "Harlot",
      description: "Visits one player each night; visiting a werewolf is deadly.",
    },
    hunter: {
      name: "Hunter",
      description: "When the wolves attack you, you may survive and take one of them down.",
    },
    princess: {
      name: "Princess",
      description: "If the village votes to eliminate you, you reveal yourself and survive once.",
    },
  },
  factions: {
    village: "Village",
    wolves: "Wolves",
  },
  phases: {
    discussion: "Discussion",
    voting: "Voting",
    night: "Night",
  },
  gameStatuses: {
    lobby: "Lobby",
    scheduled: "Scheduled",
    running: "Running",
    finished: "Finished",
    cancelled: "Cancelled",
  },
  playerStatuses: {
    lobby: "In lobby",
    alive: "Alive",
    dead: "Dead",
    spectator: "Spectator",
  },
  actions: {
    "wolf.attack": {
      label: "Attack",
      prompt: "Choose who the wolves will attack tonight.",
    },
    "seer.inspect": {
      label: "Inspect",
      prompt: "Choose a player to learn their role.",
    },
    "harlot.visit": {
      label: "Visit",
      prompt: "Choose a player to visit tonight. Visiting a werewolf is deadly.",
    },
    "harlot.stay": {
      label: "Stay home",
      prompt: "Stay home and take no risks tonight.",
    },
  },
  errors: {
    GAME_NOT_FOUND: "That game could not be found.",
    GAME_ALREADY_STARTED: "That game has already started.",
    GAME_NOT_STARTED: "That game has not started yet.",
    GAME_CANCELLED: "That game was cancelled.",
    NOT_A_MEMBER: "You are not a member of this game.",
    NOT_GAME_OWNER: "Only the game owner can do that.",
    NOT_ALIVE: "Only living players can do that.",
    PHASE_MISMATCH: "The game has moved on; try again.",
    PHASE_CLOSED: "That phase has already ended.",
    ACTION_NOT_AVAILABLE: "That action is not available right now.",
    INVALID_TARGET: "That player is not a valid target.",
    CHAT_READ_ONLY: "Chat is read-only right now.",
    CHANNEL_NOT_AVAILABLE: "That chat channel is not available.",
    MIN_PLAYERS_NOT_REACHED: "Not enough players have joined to start the game.",
  },
  events: {
    // Scopes mirror the protocol: public events are seen by everyone, player
    // events by a single viewer. Server-scope audit events are never rendered.
    public: {
      "game.started": "The game has started.",
      "phase.started": "The {{phase}} phase has begun.",
      "vote.resolved": "The vote is over. {{abstain}} abstained and {{noVote}} did not vote.",
      "player.eliminated": "{{player}} was eliminated. Their role was {{role}}.",
      "princess.revealed": "{{player}} revealed themselves as the Princess.",
      "night.resolved": {
        count_one: "{{count}} player died during the night.",
        count_other: "{{count}} players died during the night.",
      },
      "game.finished": "The game is over. {{faction}} won.",
      "chat.message": "{{text}}",
      "game.start_deferred": {
        count_one: "Only {{count}} player has joined; the game needs at least {{minimum}}.",
        count_other: "Only {{count}} players have joined; the game needs at least {{minimum}}.",
      },
    },
    player: {
      "role.assigned": "Your role is {{role}}.",
      "seer.result": "{{player}} is a {{role}}.",
      "cursed.converted": "You were turned into a werewolf. Your new role is {{role}}.",
      "harlot.result": {
        safe: "You returned home safely.",
        killed: "You were killed during your visit.",
      },
      "wolves.member_joined": "{{player}} has joined the wolves.",
      "masons.member_joined": "{{player}} is a mason.",
    },
  },
  ui: {
    signIn: "Sign in",
    signOut: "Sign out",
    createGame: "Create game",
    join: "Join",
    spectate: "Spectate",
    leave: "Leave",
    start: "Start",
    cancel: "Cancel",
    lobby: "Lobby",
    players: {
      count_one: "{{count}} player",
      count_other: "{{count}} players",
    },
    waitingForPlayers: "Waiting for players…",
    timeRemaining: {
      count_one: "{{count}} second remaining",
      count_other: "{{count}} seconds remaining",
    },
    sendMessage: "Send message",
    publicChat: "Public chat",
    wolfChat: "Wolf chat",
    yourRole: "Your role",
    vote: "Vote",
    abstain: "Abstain",
    noVote: "No vote",
    replay: "Replay",
    notEnoughPlayers: "Not enough players to start. You need at least {{count}}.",
  },
};

export type TranslationResource = typeof en;
