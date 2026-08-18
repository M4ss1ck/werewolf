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
      description:
        "Attacks one villager each night; your pack wins only when every other player is dead.",
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
      description:
        "When the wolves or the serial killer attack you, you may survive and take one of them down.",
    },
    princess: {
      name: "Princess",
      description: "If the village votes to eliminate you, you reveal yourself and survive once.",
    },
    veteran: {
      name: "Veteran",
      description:
        "You win alone — but only if the village votes to eliminate you. Any other death and you lose.",
    },
    serial_killer: {
      name: "Serial Killer",
      description:
        "Visits one house each night and kills whoever is home. Wins by being the last one standing.",
    },
  },
  factions: {
    village: "Village",
    wolves: "Wolves",
    veteran: "The Veteran",
    serial_killer: "The Serial Killer",
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
      prompt:
        "Choose a player to visit tonight. Walking into the house the killers attack is deadly.",
    },
    "harlot.stay": {
      label: "Stay home",
      prompt: "Stay home and take no risks tonight.",
    },
    "serial_killer.visit": {
      label: "Visit",
      prompt:
        "Choose a house to visit tonight. Everyone standing in it dies — and a werewolf you run into is a coin toss.",
    },
    "serial_killer.stay": {
      label: "Stay home",
      prompt: "Kill no one tonight and stay out of the wolves' way.",
    },
  },
  errors: {
    UNKNOWN_ERROR: "Something went wrong. Please try again.",
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
    RATE_LIMITED: "You are sending messages too quickly.",
    USERNAME_REQUIRED: "Choose a username before joining a game.",
    INVALID_USERNAME:
      "That username is not allowed. Use 3-24 characters: letters, numbers, spaces, hyphens or underscores.",
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
    save: "Save",
    backToGames: "Back to games",
    lobby: {
      label: "Lobby",
      waitingForPlayers: "Waiting for players",
      seatsFilled: "{{count}} / {{min}}",
      oneMoreNeeded: {
        count_one: "One more villager and the host can begin.",
        count_other: "{{count}} more villagers and the host can begin.",
      },
      inTheVillage: "In the village",
      emptySeat: "Empty seat",
      youHost: "You · host",
      botTag: "Bot",
      addBot: "Add bot",
      botRandom: "Plays at random",
      botReason: {
        PROVIDER_NOT_CONFIGURED: "No AI provider configured",
        MODEL_NOT_AVAILABLE: "Model unavailable",
        ALREADY_SEATED: "Already in the village",
      },
      startNeeds: {
        count_one: "Start · needs {{count}}",
        count_other: "Start · needs {{count}}",
      },
      kickPlayer: "Remove {{player}}",
    },
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
    factionTeam: "{{faction}} team",
    vote: {
      label: "Vote",
      title: "Who hangs today?",
      progress: "{{acted}}/{{eligible}} voted",
      lockVote: "Lock vote · {{player}}",
      lockAbstain: "Lock abstention",
      voteLocked: "Vote locked",
    },
    abstain: "Abstain",
    noVote: "No vote",
    replay: "Replay",
    notEnoughPlayers: "Not enough players to start. You need at least {{count}}.",
    homeTagline: "Gather the village, hide among the pack, and survive until dawn.",
    openGames: "Open games",
    noOpenGames: "No open games yet — the village is quiet. Create one and be the first to howl.",
    gameName: "Game name",
    gameNamePlaceholder: "Name your village",
    visibility: "Visibility",
    visibilityPublic: "Public",
    visibilityPrivate: "Private",
    allowSpectating: "Allow spectating",
    allowSpectatingHint: "Dead players and guests can watch",
    scheduledStart: "Scheduled start",
    scheduleManual: "Start manually",
    scheduleInMinutes: {
      count_one: "In {{count}} min",
      count_other: "In {{count}} min",
    },
    scheduleInHour: "In an hour",
    schedulePickTime: "Pick a time",
    scheduleStartsAt: "Starts at {{time}}",
    schedulePastTime: "Pick a time in the future.",
    phaseDurations: "Phase durations",
    seconds: "seconds",
    secondsShort: "s",
    day: "Day {{count}}",
    you: "you",
    yourMove: "Your move",
    yourIntel: "Your intel",
    messageLabel: "Message",
    messagePlaceholder: "Say something",
    chatEmpty: "No messages yet — the night is quiet. Break the silence.",
    votingProgress: "Voting progress",
    reconnecting: "Reconnecting…",
    spectating: "You are spectating this game.",
    language: "Language",
    phaseRail: "Game phase",
    readyToStart: "Ready to start",
    username: "Username",
    usernamePlaceholder: "e.g. moonwatcher",
    usernameHint: "3–24 characters",
    chooseUsername: "Choose a username",
    chooseUsernameIntro: "This is the name the village will see.",
    saveUsername: "Save username",
    globalChat: "Global chat",
    globalChatEmpty: "No messages yet. Say hello.",
    tabs: {
      games: "Games",
      create: "Create",
      profile: "Profile",
      chat: "Chat",
      village: "Village",
      talk: "Talk",
      act: "Act",
      me: "Me",
    },
    browser: {
      filterAll: "All",
      filterLobby: "Lobby",
      filterRunning: "Running",
      startsIn: "starts in {{time}}",
      finished: "finished",
      dayPhase: "day {{day}} · {{phase}}",
    },
    night: {
      label: {
        count_one: "Night {{count}}",
        count_other: "Night {{count}}",
      },
      yourMove: "Your move · {{role}}",
      villageSleeps: "The village sleeps. Public chat is closed until dawn.",
      confirm: "Confirm · {{player}}",
      noAction: "Nothing to do tonight.",
    },
    cancelled: {
      title: "Game cancelled",
      body: "The host cancelled this game.",
    },
    over: {
      villageWins: "the village wins",
      packWins: "the pack wins",
      veteranWins: "the veteran wins",
      serialKillerWins: "the serial killer wins",
      villageWinsTitle: "The pack is broken",
      wolvesWinTitle: "The village falls",
      veteranWinsTitle: "Exactly as planned",
      serialKillerWinsTitle: "The last one standing",
      reasonWolvesEliminated: "All the wolves were eliminated.",
      reasonVillageEliminated: "The wolves killed everyone else.",
      reasonVeteranLynched: "The village lynched the veteran. Everyone else loses.",
      reasonSerialKillerSurvives: "The serial killer outlived everyone.",
      rolesRevealed: "Roles revealed",
      replay: "Replay",
      watchReplay: "Watch replay",
      newGame: "New game",
      wolvesCount: {
        count_one: "{{count}} wolf",
        count_other: "{{count}} wolves",
      },
      villagersCount: {
        count_one: "{{count}} villager",
        count_other: "{{count}} villagers",
      },
      nightsCount: {
        count_one: "{{count}} night",
        count_other: "{{count}} nights",
      },
      summary: "{{wolves}} outlasted {{villagers}} over {{nights}}.",
    },
    profile: {
      editUsername: "Edit username",
      games: "games",
      survived: "survived",
      asWolf: "as wolf",
      settings: "Settings",
      language: "Language",
      phaseNotifications: "Phase notifications",
      phaseNotificationsHint: "Nudge me when a phase turns",
      reducedMotion: "Reduced motion",
      reducedMotionHint: "Fade instead of animate",
      signOut: "Sign out",
    },
    intel: {
      title: "Your intel",
      nightMarker: "N{{count}}",
      dayMarker: "D{{count}}",
      villageAlive: {
        count_one: "The village · {{count}} alive",
        count_other: "The village · {{count}} alive",
      },
    },
  },
};

export type TranslationResource = typeof en;
