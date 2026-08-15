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
      description: "Ataca a un aldeano cada noche; tu manada gana superando en número a la aldea.",
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
      description: "Cuando los lobos te atacan, puedes sobrevivir y llevarte a uno contigo.",
    },
    princess: {
      name: "Princesa",
      description: "Si la aldea vota para eliminarte, te revelas y sobrevives una vez.",
    },
  },
  factions: {
    village: "La aldea",
    wolves: "Los lobos",
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
      prompt: "Elige a un jugador al que visitar esta noche. Visitar a un hombre lobo es mortal.",
    },
    "harlot.stay": {
      label: "Quedarse en casa",
      prompt: "Quédate en casa y no corras riesgos esta noche.",
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
  },
  events: {
    public: {
      "game.started": "La partida ha comenzado.",
      "phase.started": "Ha comenzado la fase de {{phase}}.",
      "vote.resolved": "La votación ha terminado. Abstenciones: {{abstain}}. Sin voto: {{noVote}}.",
      "player.eliminated": "{{player}} ya no está en la partida. Su rol era {{role}}.",
      "princess.revealed": "{{player}} se ha revelado como la Princesa.",
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
      "cursed.converted": "Te has convertido en hombre lobo. Tu nuevo rol es {{role}}.",
      "harlot.result": {
        safe: "Volviste a casa sin problemas.",
        killed: "Te mataron durante tu visita.",
      },
      "wolves.member_joined": "{{player}} se ha unido a los lobos.",
      "masons.member_joined": "{{player}} es masón.",
    },
  },
  ui: {
    signIn: "Iniciar sesión",
    signOut: "Cerrar sesión",
    createGame: "Crear partida",
    join: "Unirse",
    spectate: "Espectar",
    leave: "Salir",
    start: "Comenzar",
    cancel: "Cancelar",
    lobby: "Sala de espera",
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
    yourRole: "Tu rol",
    vote: "Votar",
    abstain: "Abstenerse",
    noVote: "No votar",
    replay: "Repetición",
    notEnoughPlayers:
      "No hay suficientes jugadores para comenzar. Se necesitan al menos {{count}}.",
    homeTagline:
      "La luna llena se alza sobre la aldea. Vota de día, caza de noche y no confíes en nadie.",
    openGames: "Partidas abiertas",
    noOpenGames:
      "Aún no hay partidas abiertas: la aldea está en calma. Crea una y sé el primero en aullar.",
    gameName: "Nombre de la partida",
    gameNamePlaceholder: "p. ej. La Posada de la Luna Llena",
    visibility: "Visibilidad",
    visibilityPublic: "Pública",
    visibilityPrivate: "Privada",
    allowSpectating: "Permitir espectadores",
    scheduledStart: "Inicio programado",
    scheduleManual: "Iniciar manualmente",
    scheduleInMinutes: {
      count_one: "En {{count}} minuto",
      count_other: "En {{count}} minutos",
    },
    scheduleInHour: "En 1 hora",
    schedulePickTime: "Elegir una hora",
    scheduleStartsAt: "Empieza a las {{time}}",
    schedulePastTime: "Elige una hora futura.",
    phaseDurations: "Duración de las fases",
    seconds: "segundos",
    day: "Día {{count}}",
    you: "tú",
    yourMove: "Tu jugada",
    yourIntel: "Tus pistas",
    messageLabel: "Mensaje",
    messagePlaceholder: "Escribe un mensaje…",
    chatEmpty: "Aún no hay mensajes: la noche está en calma. Rompe el silencio.",
    votingProgress: "Progreso de la votación",
    reconnecting: "Reconectando…",
    spectating: "Estás espectando esta partida.",
    language: "Idioma",
    phaseRail: "Fase de la partida",
    readyToStart: "Lista para comenzar",
  },
};
