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
    alpha_wolf: {
      name: "Alpha Wolf",
      description:
        "You hunt with the pack. Each night, your bite may turn the pack's victim into a werewolf instead of killing them.",
    },
    drunk: {
      name: "Drunk",
      description:
        "Believes they are another village role and acts on that belief, but the results they get are wrong. Their true role is revealed on death.",
    },
    mayor: {
      name: "Mayor",
      description:
        "Once per game, during the day, you may reveal yourself and name the day's elimination outright, overriding the vote — or pardon everyone and cancel the lynch.",
    },
    cupid: {
      name: "Cupid",
      description:
        "On the first night, links two players' lives. If one dies, the other dies with them, and they win together.",
    },
    priest: {
      name: "Priest",
      description:
        "Each night, shields one player from every attack. You may not shield the same player on two nights running.",
    },
    guardian: {
      name: "Guardian",
      description:
        "On the first night, bonds to one player. If they are ever attacked, you die in their place.",
    },
    cub: {
      name: "Cub",
      description: "A young wolf with no special power: you hunt with the pack and win with it.",
    },
    sorcerer: {
      name: "Sorcerer",
      description:
        "You win with the wolves but are no part of the pack: no wolf chat, no hunt, and the pack may eat you. Each night you divine one player and learn only whether they are a wolf.",
    },
    lone_wolf: {
      name: "Lone Wolf",
      description:
        "A wolf who answers to nobody. Each night you search a house for the Alpha, and if you find them you fight: one of you dies. Win, and you take their place at the head of the pack. That is your only way to win — until then the pack can eat you like anyone else.",
    },
    detective: {
      name: "Detective",
      description:
        "Visits one player each night to investigate them. Half the time you learn their role; a miss is inconclusive, never a lie. The walk is risky — if the killers come to that house, you die there.",
    },
    cult_leader: {
      name: "Cult Leader",
      description:
        "Each night, converts one living player into a cultist. The cult wins by being the only ones left. You travel to the house you convert, so the walk can be deadly.",
    },
    cultist: {
      name: "Cultist",
      description:
        "A converted member of the cult. You have no power of your own: the cult wins by being the only ones left.",
    },
  },
  factions: {
    village: "Village",
    wolves: "Wolves",
    veteran: "The Veteran",
    serial_killer: "The Serial Killer",
    cult: "The Cult",
    lone_wolf: "The Lone Wolf",
  },
  presets: {
    classic: {
      name: "Classic",
      description: "The classic village: the familiar roster, no surprises.",
    },
    chaos: {
      name: "Chaos",
      description: "Every role in the game is in play. Anything can happen.",
    },
    cult: {
      name: "Cult",
      description: "A cult leader is among you, and the village has the tools to fight back.",
    },
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
    "mayor.reveal": {
      label: "Reveal and name",
      prompt:
        "Step forward, reveal yourself as the Mayor, and name who hangs today — the vote no longer decides it.",
    },
    "mayor.pardon": {
      label: "Reveal and pardon",
      prompt:
        "Step forward, reveal yourself as the Mayor, and spare the village — nobody hangs today.",
    },
    "cupid.link": {
      label: "Link",
      prompt: "Choose two players whose lives will be bound together.",
    },
    "priest.protect": {
      label: "Protect",
      prompt: "Choose a player to shield from every attack tonight.",
    },
    "guardian.bond": {
      label: "Bond",
      prompt: "Choose a player to bond with. If they are attacked, you die in their place.",
    },
    "sorcerer.divine": {
      label: "Divine",
      prompt: "Choose a player and learn only whether they are a wolf.",
    },
    "lone_wolf.search": {
      label: "Search",
      prompt:
        "Choose a house to search for the Alpha tonight. If they are there, only one of you walks away.",
    },
    "detective.investigate": {
      label: "Investigate",
      prompt:
        "Choose a player to investigate tonight. You visit their house: half the time you learn their role, but if the killers come you die there.",
    },
    "cult.convert": {
      label: "Convert",
      prompt:
        "Choose a living player to convert into a cultist tonight. You walk to their house, so the visit can be deadly.",
    },
  },
  errors: {
    UNKNOWN_ERROR: "Something went wrong. Please try again.",
    GAME_NOT_FOUND: "That game could not be found.",
    GAME_ALREADY_STARTED: "That game has already started.",
    GAME_NOT_STARTED: "That game has not started yet.",
    GAME_CANCELLED: "That game was cancelled.",
    INVITATION_NOT_FOUND: "That game invitation could not be found.",
    INVITATION_ACCESS_DENIED: "You do not have access to that game invitation.",
    SPECTATING_DISABLED: "Spectating is disabled for this game.",
    NOT_A_MEMBER: "You are not a member of this game.",
    NOT_GAME_OWNER: "Only the game owner can do that.",
    NOT_ALIVE: "Only living players can do that.",
    PHASE_MISMATCH: "The game has moved on; try again.",
    PHASE_CLOSED: "That phase has already ended.",
    ACTION_NOT_AVAILABLE: "That action is not available right now.",
    INVALID_TARGET: "That player is not a valid target.",
    INVALID_MENTION: "That mention is no longer valid. Refresh suggestions and try again.",
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
      "players.finished_off": "Final resistance eliminated by {{faction}}: {{players}}.",
      "princess.revealed": "{{player}} revealed themselves as the Princess.",
      "mayor.revealed": "{{player}} revealed themselves as the Mayor.",
      "night.resolved": {
        count_one: "{{count}} player died during the night.",
        count_other: "{{count}} players died during the night.",
      },
      "game.finished": "The game is over — {{faction}}.",
      "chat.message": "{{text}}",
      "game.start_deferred": {
        count_one: "Only {{count}} player has joined; the game needs at least {{minimum}}.",
        count_other: "Only {{count}} players have joined; the game needs at least {{minimum}}.",
      },
    },
    player: {
      "role.assigned": "Your role is {{role}}.",
      "seer.result": "{{player}} is a {{role}}.",
      "sorcerer.result": {
        wolf: "{{player}} is a wolf.",
        notWolf: "{{player}} is not a wolf.",
      },
      "player.converted": "You were turned into a werewolf. Your new role is {{role}}.",
      "harlot.result": {
        safe: "You returned home safely.",
        killed: "You were killed during your visit.",
      },
      "player.linked": "You are linked to {{partnerId}}.",
      "lone_wolf.result": {
        found: "You found the Alpha at {{player}}'s house.",
        notFound: "No sign of the Alpha at {{player}}'s house.",
      },
      "detective.result": {
        role: "Your investigation: {{player}} is a {{role}}.",
        inconclusive: "Your investigation of {{player}} was inconclusive.",
      },
      "wolves.member_joined": "{{player}} has joined the wolves.",
      "masons.member_joined": "{{player}} is a mason.",
      "cult.member_joined": "{{player}} has joined the cult.",
    },
  },
  ui: {
    signIn: "Sign in",
    signInDev: "Sign in as developer",
    signInFailed: "Sign-in could not be completed.",
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
    dismiss: "Dismiss",
    publicChat: "Public chat",
    wolfChat: "Wolf chat",
    graveChat: "Grave chat",
    cultChat: "Cult chat",
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
    channelMembers: "In this channel",
    messagePlaceholder: "Say something",
    chatEmpty: "No messages yet — the night is quiet. Break the silence.",
    ready: "Ready",
    readyState: {
      ready: "Ready",
      notReady: "Not ready",
    },
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
    unread: "Unread",
    mentionedYou: "Mentioned you",
    jumpToLatest: "Jump to latest",
    jumpToFirstUnread: "Jump to first unread",
    unreadMessages_one: "{{count}} unread message",
    unreadMessages_other: "{{count}} unread messages",
    earlierMessagesUnavailable: "Earlier messages are no longer available",
    mentionSearchLoading: "Searching people…",
    mentionSearchEmpty: "No people found",
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
    dayAction: {
      yourMove: "Your move · {{role}}",
      confirm: "Confirm · {{player}}",
      noAction: "Nothing to do today.",
    },
    action: {
      confirm: "Confirm",
      pickCount: "Pick {{count}}",
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
      cultWins: "the cult wins",
      drawFaction: "nobody",
      villageWinsTitle: "The pack is broken",
      wolvesWinTitle: "The village falls",
      veteranWinsTitle: "Exactly as planned",
      serialKillerWinsTitle: "The last one standing",
      cultWinsTitle: "The cult takes the village",
      drawTitle: "A draw",
      winner: "Winner",
      reasonWolvesEliminated: "All the wolves were eliminated.",
      reasonVillageEliminated: "The wolves killed everyone else.",
      reasonVeteranLynched: "The village lynched the veteran. Everyone else loses.",
      reasonSerialKillerSurvives: "The serial killer outlived everyone.",
      reasonCultSurvives: "The cult converted everyone else.",
      reasonStalemate: "Five nights passed with nobody eliminated.",
      reasonNoSurvivors: "Nobody survived the night.",
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
