// Spanish resource bundle. Typed against `TranslationResource` (derived from
// the English bundle) so the two can never drift: a missing or extra Spanish
// key, or a key with the wrong shape, is a compile error.
//
// Same rules as English: machine identifiers stay as object keys, values are
// i18next templates, and plurals use `count_one` / `count_other` so the
// library applies the Spanish plural rule.

import type { TranslationResource } from "./en.ts";

export const es: TranslationResource = {
  roles: {
    villager: {
      name: "Aldeano",
      description: "Sin poderes especiales: caza a los lobos solo con votos y deducción.",
    },
    werewolf: {
      name: "Hombre Lobo",
      description:
        "Ataca a un aldeano cada noche; tu manada gana solo cuando todos los demás jugadores están muertos.",
    },
    mason: {
      name: "Masón",
      description: "Sabe quiénes son los demás masones y puede confiar en ellos.",
    },
    seer: {
      name: "Vidente",
      description: "Inspecciona a un jugador cada noche y descubre su rol.",
    },
    cursed: {
      name: "Aldeano Maldito",
      description: "Un aldeano que se convierte en hombre lobo si los lobos lo atacan.",
    },
    harlot: {
      name: "Cortesana",
      description: "Visita a un jugador cada noche; visitar a un hombre lobo es mortal.",
    },
    hunter: {
      name: "Cazador",
      description:
        "Cuando los lobos o el asesino en serie te atacan, puedes sobrevivir y llevarte a uno contigo.",
    },
    princess: {
      name: "Princesa",
      description: "Si la aldea vota para eliminarte, te revelas y sobrevives una vez.",
    },
    veteran: {
      name: "Veterano",
      description:
        "Ganas en solitario, pero solo si la aldea vota para eliminarte. Cualquier otra muerte y pierdes.",
    },
    serial_killer: {
      name: "Asesino en Serie",
      description:
        "Visita una casa cada noche y mata a quien esté dentro. Gana siendo el último en pie.",
    },
    alpha_wolf: {
      name: "Lobo Alfa",
      description:
        "Cazas con la manada. Cada noche, tu mordisco puede convertir a la víctima de la manada en hombre lobo en lugar de matarla.",
    },
    drunk: {
      name: "Borracho",
      description:
        "Cree que es otro rol de la aldea y actúa en consecuencia, pero los resultados que obtiene son erróneos. Su rol real se revela al morir.",
    },
    mayor: {
      name: "Alcalde",
      description:
        "Una vez por partida, durante el día, puedes revelarte y nombrar directamente al eliminado del día, anulando la votación; o indultar a todos y cancelar el linchamiento.",
    },
    cupid: {
      name: "Cupido",
      description:
        "En la primera noche, une las vidas de dos jugadores. Si uno muere, el otro muere con él, y ganan juntos.",
    },
    priest: {
      name: "Sacerdote",
      description:
        "Cada noche, protege a un jugador de todos los ataques. No puedes proteger al mismo jugador dos noches seguidas.",
    },
    guardian: {
      name: "Guardián",
      description:
        "En la primera noche, se une a un jugador. Si alguna vez lo atacan, mueres en su lugar.",
    },
    cub: {
      name: "Cachorro",
      description: "Un lobo joven sin poderes especiales: cazas con la manada y ganas con ella.",
    },
    sorcerer: {
      name: "Brujo",
      description:
        "Ganas con los lobos pero no eres parte de la manada: sin chat de lobos, sin cacería, y la manada puede devorarte. Cada noche adivinas a un jugador y solo aprendes si es lobo o no.",
    },
    lone_wolf: {
      name: "Lobo Solitario",
      description:
        "Un lobo que no rinde cuentas a nadie. Cada noche registras una casa en busca del Alfa, y si lo encuentras peleáis: uno de los dos muere. Si ganas, ocupas su lugar al frente de la manada. Es tu única forma de ganar, y hasta entonces la manada puede devorarte como a cualquiera.",
    },
    detective: {
      name: "Detective",
      description:
        "Visita a un jugador cada noche para investigarlo. La mitad de las veces descubres su rol; si fallas, el resultado no es concluyente, nunca miente. El paseo es arriesgado: si los asesinos llegan a esa casa, mueres allí.",
    },
    cult_leader: {
      name: "Líder del Culto",
      description:
        "Cada noche, convierte a un jugador vivo en sectario. El culto gana siendo los únicos que quedan. Viajas a la casa de quien conviertes, así que el paseo puede ser mortal.",
    },
    cultist: {
      name: "Sectario",
      description:
        "Un miembro convertido del culto. No tienes poder propio: el culto gana siendo los únicos que quedan.",
    },
  },
  factions: {
    village: "La aldea",
    wolves: "Los lobos",
    veteran: "El Veterano",
    serial_killer: "El Asesino en Serie",
    cult: "El Culto",
    lone_wolf: "El Lobo Solitario",
  },
  presets: {
    classic: {
      name: "Clásico",
      description: "La aldea clásica: los roles de siempre, sin sorpresas.",
    },
    chaos: {
      name: "Caos",
      description: "Todos los roles del juego están en juego. Puede pasar cualquier cosa.",
    },
    cult: {
      name: "Culto",
      description:
        "Un líder de culto se oculta entre vosotros y la aldea tiene con qué defenderse.",
    },
  },
  phases: {
    discussion: "Discusión",
    voting: "Votación",
    night: "Noche",
  },
  gameStatuses: {
    lobby: "Sala de espera",
    scheduled: "Programada",
    running: "En curso",
    finished: "Terminada",
    cancelled: "Cancelada",
  },
  playerStatuses: {
    lobby: "En la sala",
    alive: "Vivo",
    dead: "Muerto",
    spectator: "Espectador",
  },
  actions: {
    "wolf.attack": {
      label: "Atacar",
      prompt: "Elige a quién atacarán los lobos esta noche.",
    },
    "seer.inspect": {
      label: "Inspeccionar",
      prompt: "Elige a un jugador para descubrir su rol.",
    },
    "harlot.visit": {
      label: "Visitar",
      prompt:
        "Elige a un jugador al que visitar esta noche. Entrar en la casa a la que atacan los asesinos es mortal.",
    },
    "harlot.stay": {
      label: "Quedarse en casa",
      prompt: "Quédate en casa y no corras riesgos esta noche.",
    },
    "serial_killer.visit": {
      label: "Visitar",
      prompt:
        "Elige una casa a la que visitar esta noche. Todos los que estén dentro morirán, y si te cruzas con un hombre lobo, es cara o cruz.",
    },
    "serial_killer.stay": {
      label: "Quedarse en casa",
      prompt: "No mates a nadie esta noche y mantente fuera del camino de los lobos.",
    },
    "mayor.reveal": {
      label: "Revelarse y nombrar",
      prompt:
        "Da un paso al frente, revélate como el Alcalde y nombra a quién cuelgan hoy: la votación ya no decide.",
    },
    "mayor.pardon": {
      label: "Revelarse e indultar",
      prompt:
        "Da un paso al frente, revélate como el Alcalde y perdona a la aldea: hoy no cuelgan a nadie.",
    },
    "cupid.link": {
      label: "Unir",
      prompt: "Elige a dos jugadores cuyas vidas quedarán unidas.",
    },
    "priest.protect": {
      label: "Proteger",
      prompt: "Elige a un jugador al que proteger de todos los ataques esta noche.",
    },
    "guardian.bond": {
      label: "Unirse",
      prompt: "Elige a un jugador con quien unirte. Si lo atacan, mueres en su lugar.",
    },
    "sorcerer.divine": {
      label: "Adivinar",
      prompt: "Elige a un jugador y descubre solo si es lobo o no.",
    },
    "lone_wolf.search": {
      label: "Registrar",
      prompt:
        "Elige una casa donde buscar al Alfa esta noche. Si está allí, solo uno de los dos saldrá con vida.",
    },
    "detective.investigate": {
      label: "Investigar",
      prompt:
        "Elige a un jugador al que investigar esta noche. Visitas su casa: la mitad de las veces descubres su rol, pero si vienen los asesinos, mueres allí.",
    },
    "cult.convert": {
      label: "Convertir",
      prompt:
        "Elige a un jugador vivo para convertirlo en sectario esta noche. Caminas hasta su casa, así que la visita puede ser mortal.",
    },
  },
  errors: {
    UNKNOWN_ERROR: "Algo salió mal. Inténtalo de nuevo.",
    GAME_NOT_FOUND: "No se encontró esa partida.",
    GAME_ALREADY_STARTED: "Esa partida ya ha comenzado.",
    GAME_NOT_STARTED: "Esa partida aún no ha comenzado.",
    GAME_CANCELLED: "Esa partida fue cancelada.",
    NOT_A_MEMBER: "No eres miembro de esta partida.",
    NOT_GAME_OWNER: "Solo el creador de la partida puede hacer eso.",
    NOT_ALIVE: "Solo los jugadores vivos pueden hacer eso.",
    PHASE_MISMATCH: "La partida ha avanzado; inténtalo de nuevo.",
    PHASE_CLOSED: "Esa fase ya ha terminado.",
    ACTION_NOT_AVAILABLE: "Esa acción no está disponible ahora mismo.",
    INVALID_TARGET: "Ese jugador no es un objetivo válido.",
    CHAT_READ_ONLY: "El chat es de solo lectura ahora mismo.",
    CHANNEL_NOT_AVAILABLE: "Ese canal de chat no está disponible.",
    MIN_PLAYERS_NOT_REACHED: "No hay suficientes jugadores para comenzar la partida.",
    RATE_LIMITED: "Estás enviando mensajes demasiado rápido.",
    USERNAME_REQUIRED: "Elige un nombre de usuario antes de unirte a una partida.",
    INVALID_USERNAME:
      "Ese nombre de usuario no está permitido. Usa 3-24 caracteres: letras, números, espacios, guiones o guiones bajos.",
  },
  events: {
    public: {
      "game.started": "La partida ha comenzado.",
      "phase.started": "Ha comenzado la fase de {{phase}}.",
      "vote.resolved": "La votación ha terminado. Abstenciones: {{abstain}}. Sin voto: {{noVote}}.",
      "player.eliminated": "{{player}} ya no está en la partida. Su rol era {{role}}.",
      "princess.revealed": "{{player}} se ha revelado como la Princesa.",
      "mayor.revealed": "{{player}} se ha revelado como el Alcalde.",
      "night.resolved": {
        count_one: "{{count}} jugador murió durante la noche.",
        count_other: "{{count}} jugadores murieron durante la noche.",
      },
      "game.finished": "La partida ha terminado. La victoria es de {{faction}}.",
      "chat.message": "{{text}}",
      "game.start_deferred": {
        count_one:
          "Solo se ha unido {{count}} jugador; se necesitan al menos {{minimum}} para comenzar.",
        count_other:
          "Solo se han unido {{count}} jugadores; se necesitan al menos {{minimum}} para comenzar.",
      },
    },
    player: {
      "role.assigned": "Tu rol es {{role}}.",
      "seer.result": "El rol de {{player}} es {{role}}.",
      "sorcerer.result": {
        wolf: "{{player}} es un lobo.",
        notWolf: "{{player}} no es un lobo.",
      },
      "player.converted": "Te has convertido en hombre lobo. Tu nuevo rol es {{role}}.",
      "harlot.result": {
        safe: "Volviste a casa sin problemas.",
        killed: "Te mataron durante tu visita.",
      },
      "player.linked": "Estás unido a {{partnerId}}.",
      "lone_wolf.result": {
        found: "Encontraste al Alfa en casa de {{player}}.",
        notFound: "Ni rastro del Alfa en casa de {{player}}.",
      },
      "detective.result": {
        role: "Tu investigación: {{player}} es {{role}}.",
        inconclusive: "Tu investigación de {{player}} no fue concluyente.",
      },
      "wolves.member_joined": "{{player}} se ha unido a los lobos.",
      "masons.member_joined": "{{player}} es masón.",
      "cult.member_joined": "{{player}} se ha unido al culto.",
    },
  },
  ui: {
    signIn: "Iniciar sesión",
    signInFailed: "No se pudo completar el inicio de sesión.",
    signOut: "Cerrar sesión",
    createGame: "Crear partida",
    join: "Unirse",
    spectate: "Espectar",
    leave: "Salir",
    start: "Comenzar",
    cancel: "Cancelar",
    save: "Guardar",
    backToGames: "Volver a las partidas",
    lobby: {
      label: "Sala de espera",
      waitingForPlayers: "Esperando jugadores",
      seatsFilled: "{{count}} / {{min}}",
      oneMoreNeeded: {
        count_one: "Un aldeano más y el anfitrión podrá comenzar.",
        count_other: "Faltan {{count}} aldeanos y el anfitrión podrá comenzar.",
      },
      inTheVillage: "En la aldea",
      emptySeat: "Asiento vacío",
      youHost: "Tú · anfitrión",
      botTag: "Bot",
      addBot: "Añadir bot",
      botRandom: "Juega al azar",
      botReason: {
        PROVIDER_NOT_CONFIGURED: "Sin proveedor de IA configurado",
        MODEL_NOT_AVAILABLE: "Modelo no disponible",
        ALREADY_SEATED: "Ya está en la aldea",
      },
      startNeeds: {
        count_one: "Comenzar · falta {{count}}",
        count_other: "Comenzar · faltan {{count}}",
      },
      kickPlayer: "Expulsar a {{player}}",
    },
    players: {
      count_one: "{{count}} jugador",
      count_other: "{{count}} jugadores",
    },
    waitingForPlayers: "Esperando jugadores…",
    timeRemaining: {
      count_one: "queda {{count}} segundo",
      count_other: "quedan {{count}} segundos",
    },
    sendMessage: "Enviar mensaje",
    publicChat: "Chat público",
    wolfChat: "Chat de los lobos",
    graveChat: "Chat de los muertos",
    cultChat: "Chat del culto",
    yourRole: "Tu rol",
    factionTeam: "Equipo de {{faction}}",
    vote: {
      label: "Votar",
      title: "¿A quién ahorcamos hoy?",
      progress: "{{acted}}/{{eligible}} han votado",
      lockVote: "Bloquear voto · {{player}}",
      lockAbstain: "Bloquear abstención",
      voteLocked: "Voto bloqueado",
    },
    abstain: "Abstenerse",
    noVote: "No votar",
    replay: "Repetición",
    notEnoughPlayers:
      "No hay suficientes jugadores para comenzar. Se necesitan al menos {{count}}.",
    homeTagline: "Reúne a la aldea, escóndete entre la manada y sobrevive hasta el amanecer.",
    openGames: "Partidas abiertas",
    noOpenGames:
      "Aún no hay partidas abiertas: la aldea está en calma. Crea una y sé el primero en aullar.",
    gameName: "Nombre de la partida",
    gameNamePlaceholder: "Nombra tu aldea",
    visibility: "Visibilidad",
    visibilityPublic: "Pública",
    visibilityPrivate: "Privada",
    allowSpectating: "Permitir espectadores",
    allowSpectatingHint: "Los muertos y los invitados pueden mirar.",
    scheduledStart: "Inicio programado",
    scheduleManual: "Iniciar manualmente",
    scheduleInMinutes: {
      count_one: "En {{count}} min",
      count_other: "En {{count}} min",
    },
    scheduleInHour: "En una hora",
    schedulePickTime: "Elegir una hora",
    scheduleStartsAt: "Empieza a las {{time}}",
    schedulePastTime: "Elige una hora futura.",
    phaseDurations: "Duración de las fases",
    seconds: "segundos",
    secondsShort: "s",
    day: "Día {{count}}",
    you: "tú",
    yourMove: "Tu jugada",
    yourIntel: "Tus pistas",
    messageLabel: "Mensaje",
    messagePlaceholder: "Di algo",
    chatEmpty: "Aún no hay mensajes: la noche está en calma. Rompe el silencio.",
    ready: "Listo",
    readyState: {
      ready: "Listo",
      notReady: "No listo",
    },
    reconnecting: "Reconectando…",
    spectating: "Estás espectando esta partida.",
    language: "Idioma",
    phaseRail: "Fase de la partida",
    readyToStart: "Lista para comenzar",
    username: "Nombre de usuario",
    usernamePlaceholder: "p. ej. vigilalunas",
    usernameHint: "3–24 caracteres",
    chooseUsername: "Elige un nombre de usuario",
    chooseUsernameIntro: "Este es el nombre que verá la aldea.",
    saveUsername: "Guardar nombre",
    globalChat: "Chat global",
    globalChatEmpty: "Aún no hay mensajes. Saluda.",
    tabs: {
      games: "Partidas",
      create: "Crear",
      profile: "Perfil",
      chat: "Chat",
      village: "Aldea",
      talk: "Charlar",
      act: "Actuar",
      me: "Yo",
    },
    browser: {
      filterAll: "Todas",
      filterLobby: "Sala",
      filterRunning: "En curso",
      startsIn: "empieza en {{time}}",
      finished: "terminada",
      dayPhase: "día {{day}} · {{phase}}",
    },
    night: {
      label: {
        count_one: "Noche {{count}}",
        count_other: "Noche {{count}}",
      },
      yourMove: "Tu jugada · {{role}}",
      villageSleeps: "La aldea duerme. El chat público está cerrado hasta el amanecer.",
      confirm: "Confirmar · {{player}}",
      noAction: "Nada que hacer esta noche.",
    },
    dayAction: {
      yourMove: "Tu jugada · {{role}}",
      confirm: "Confirmar · {{player}}",
      noAction: "Nada que hacer hoy.",
    },
    action: {
      confirm: "Confirmar",
      pickCount: "Elige {{count}}",
    },
    cancelled: {
      title: "Partida cancelada",
      body: "El anfitrión canceló esta partida.",
    },
    over: {
      villageWins: "la aldea gana",
      packWins: "la manada gana",
      veteranWins: "gana el veterano",
      serialKillerWins: "gana el asesino en serie",
      cultWins: "gana el culto",
      drawFaction: "nadie",
      villageWinsTitle: "La manada está rota",
      wolvesWinTitle: "La aldea cae",
      veteranWinsTitle: "Exactamente según lo planeado",
      serialKillerWinsTitle: "El último en pie",
      cultWinsTitle: "El culto se apodera de la aldea",
      drawTitle: "Empate",
      reasonWolvesEliminated: "Todos los lobos fueron eliminados.",
      reasonVillageEliminated: "Los lobos mataron a todos los demás.",
      reasonVeteranLynched: "La aldea ahorcó al veterano. Todos los demás pierden.",
      reasonSerialKillerSurvives: "El asesino en serie sobrevivió a todos.",
      reasonCultSurvives: "El culto convirtió a todos los demás.",
      reasonStalemate: "Pasaron cinco noches sin que nadie fuera eliminado.",
      reasonNoSurvivors: "Nadie sobrevivió a la noche.",
      rolesRevealed: "Roles revelados",
      replay: "Repetición",
      watchReplay: "Ver repetición",
      newGame: "Nueva partida",
      wolvesCount: {
        count_one: "{{count}} lobo",
        count_other: "{{count}} lobos",
      },
      villagersCount: {
        count_one: "{{count}} aldeano",
        count_other: "{{count}} aldeanos",
      },
      nightsCount: {
        count_one: "{{count}} noche",
        count_other: "{{count}} noches",
      },
      summary: "{{wolves}} frente a {{villagers}} en {{nights}}.",
    },
    profile: {
      editUsername: "Editar nombre",
      games: "partidas",
      survived: "supervivencia",
      asWolf: "como lobo",
      settings: "Ajustes",
      language: "Idioma",
      phaseNotifications: "Notificaciones de fase",
      phaseNotificationsHint: "Avísame cuando cambie una fase.",
      reducedMotion: "Reducir el movimiento",
      reducedMotionHint: "Fundido en lugar de animación.",
      signOut: "Cerrar sesión",
    },
    intel: {
      title: "Tus pistas",
      nightMarker: "N{{count}}",
      dayMarker: "D{{count}}",
      villageAlive: {
        count_one: "La aldea · {{count}} vivo",
        count_other: "La aldea · {{count}} vivos",
      },
    },
  },
};
