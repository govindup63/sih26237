/**
 * Every tile and sprite is authored here as rows of palette characters, so the
 * repository carries no binary assets and the whole look can be restyled by
 * editing one table. Drawn at 1:1 onto an offscreen canvas and blitted with
 * smoothing off, which is what keeps the pixels square at any zoom.
 */

export const TILE = 16

export const PALETTE: Record<string, string> = {
  '.': 'transparent',
  // A warm ramp, darkest to lightest. On paper the rooms are the light ground and
  // the bulkheads are the dark structure, which is the way a deck plan is drawn.
  '0': '#2b2a28',
  '1': '#3a3937',
  '2': '#4b4a46',
  '3': '#605e59',
  '4': '#79776f',
  '5': '#95928a',
  '6': '#b0ada4',
  '7': '#c9c6bd',
  '8': '#e0ddd4',
  '9': '#f7f4ec',
  // Decoration is held near-neutral on purpose. If nine tenths of the plan is
  // greyscale then any saturated pixel on it means something, and the one room
  // that lights up at the end lands. A colourful ship has nowhere left to go.
  a: '#43463c',
  b: '#5a5c4e',
  c: '#7d7e6c',
  d: '#a76a09',
  e: '#7a7263',
  f: '#9e8b7e',
  // A lit screen glows amber, the same accent the rest of the page uses.
  g: '#f2c265',
  h: '#756d5e',
  i: '#ddd4c4',
  j: '#bab1a2',
  k: '#332d25',
  l: '#7d8468',
  m: '#a8391f',
  n: '#30302a',
  o: '#605a4c',
  p: '#7d7566',
}

type Art = string[]

/** Deck plating. The rivets give the floor a scale so rooms do not read as flat. */
const floor: Art = [
  '7777777777777777',
  '7888888888888887',
  '7868888888886887',
  '7888888888888887',
  '7888888888888887',
  '7888888888888887',
  '7888888888888887',
  '7888888888888887',
  '7888888888888887',
  '7888888888888887',
  '7888888888888887',
  '7888888888888887',
  '7868888888886887',
  '7888888888888887',
  '7888888888888887',
  '7777777777777777',
]

/** Bulkhead: lit along the top edge, shadowed along the bottom. */
const wall: Art = [
  '5555555555555555',
  '4444444444444444',
  '3333333333333333',
  '3322333223322333',
  '3333333333333333',
  '3333333333333333',
  '2222222222222222',
  '3333333333333333',
  '3333333333333333',
  '3322333223322333',
  '3333333333333333',
  '3333333333333333',
  '2222222222222222',
  '2222222222222222',
  '1111111111111111',
  '1111111111111111',
]

const deskTop: Art = [
  '................',
  '................',
  '................',
  '................',
  '5555555555555555',
  '6666666666666666',
  '5555555555555555',
  '4444444444444444',
  '3333333333333333',
  '2222222222222222',
  '..3..........3..',
  '..3..........3..',
  '..3..........3..',
  '..3..........3..',
  '..2..........2..',
  '................',
]

/** A workstation nobody is signed into. */
const monitorOff: Art = [
  '................',
  '....444444444...',
  '....4kkkkkkk4...',
  '....4kkkkkkk4...',
  '....4kkkkkkk4...',
  '....4kkkkkkk4...',
  '....4kkkkkkk4...',
  '....4kkkkkkk4...',
  '....444444444...',
  '.......444......',
  '.......444......',
  '....4444444444..',
  '................',
  '................',
  '................',
  '................',
]

/** The same workstation with a document open on it. */
const monitorOn: Art = [
  '................',
  '....555555555...',
  '....5hhhhhhh5...',
  '....5hgggggh5...',
  '....5hg999gh5...',
  '....5hg9g9gh5...',
  '....5hg999gh5...',
  '....5hhhhhhh5...',
  '....555555555...',
  '.......555......',
  '.......555......',
  '....5555555555..',
  '................',
  '................',
  '................',
  '................',
]

/** A workstation that has refused somebody. */
const monitorDenied: Art = [
  '................',
  '....555555555...',
  '....5kkkkkkk5...',
  '....5kmkkkmk5...',
  '....5kkmkmkk5...',
  '....5kkkmkkk5...',
  '....5kkmkmkk5...',
  '....5kmkkkmk5...',
  '....555555555...',
  '.......555......',
  '.......555......',
  '....5555555555..',
  '................',
  '................',
  '................',
  '................',
]

/** A ledger attester. The lamps say whether it is still on the majority view. */
const rackOk: Art = [
  '................',
  '..444444444444..',
  '..4l3333333l34..',
  '..433333333334..',
  '..4l3333333l34..',
  '..433333333334..',
  '..4l3333333l34..',
  '..433333333334..',
  '..4l3333333l34..',
  '..433333333334..',
  '..4l3333333l34..',
  '..433333333334..',
  '..4l3333333l34..',
  '..444444444444..',
  '..333333333333..',
  '................',
]

const rackBad: Art = [
  '................',
  '..444444444444..',
  '..4m3333333m34..',
  '..433333333334..',
  '..4m3333333m34..',
  '..433333333334..',
  '..4m3333333m34..',
  '..433333333334..',
  '..4m3333333m34..',
  '..433333333334..',
  '..4m3333333m34..',
  '..433333333334..',
  '..4m3333333m34..',
  '..444444444444..',
  '..333333333333..',
  '................',
]

const chair: Art = [
  '................',
  '................',
  '....333333......',
  '...34444443.....',
  '...34444443.....',
  '...34444443.....',
  '...34444443.....',
  '....333333......',
  '..3333333333....',
  '..3444444443....',
  '..3333333333....',
  '.....3..3.......',
  '.....3..3.......',
  '....33..33......',
  '................',
  '................',
]

const plant: Art = [
  '................',
  '.......c........',
  '......ccc.......',
  '.....cbcbc......',
  '....cbcccbc.....',
  '...cbcccccbc....',
  '....cbcccbc.....',
  '.....cbcbc......',
  '......ccc.......',
  '.......b........',
  '.......b........',
  '.....ffffff.....',
  '.....feeeef.....',
  '.....feeeef.....',
  '......ffff......',
  '................',
]

const door: Art = [
  '4444444444444444',
  '4555555555555554',
  '4566666666666654',
  '4566666666666654',
  '4566666666666654',
  '4566d66666d66654',
  '4566666666666654',
  '4566666666666654',
  '4566666666666654',
  '4566666666666654',
  '4566666666666654',
  '4555555555555554',
  '4444444444444444',
  '3333333333333333',
  '2222222222222222',
  '1111111111111111',
]

/** Chart table in the cabin: where a document gets sealed. */
const table: Art = [
  '................',
  '................',
  '.pppppppppppppp.',
  '.poooooooooooop.',
  '.po99999999990op',
  '.po9hhhhhhhh90op',
  '.po9h999999h90op',
  '.po9hhhhhhhh90op',
  '.po99999999990op',
  '.poooooooooooop.',
  '.pppppppppppppp.',
  '..p..........p..',
  '..p..........p..',
  '..p..........p..',
  '..o..........o..',
  '................',
]

/** The forensic bench in the security office. */
const bench: Art = [
  '................',
  '....5555555.....',
  '....5ggggg5.....',
  '....5g999g5.....',
  '....5ggggg5.....',
  '....5555555.....',
  '................',
  '.66666666666666.',
  '.55555555555555.',
  '.44444444444444.',
  '.33333333333333.',
  '..3..........3..',
  '..3..........3..',
  '..3..........3..',
  '..2..........2..',
  '................',
]

export const TILES: Record<string, Art> = {
  floor,
  wall,
  desk: deskTop,
  monitorOff,
  monitorOn,
  monitorDenied,
  rackOk,
  rackBad,
  chair,
  plant,
  door,
  table,
  bench,
}

/**
 * Officers are 16 wide and 20 tall so they stand above a 16px tile rather than
 * sitting inside it. Uniform colour distinguishes rank at a glance.
 */
function officerSprite(coat: string, trim: string): Art {
  return [
    '.....000000.....',
    '....00000000....',
    '....0dddddd0....',
    '....0iiiiii0....',
    '....iiiiiiii....',
    '....i0iii0ii....',
    '....iiiiiiii....',
    '.....iiiiii.....',
    '......iiii......',
    `...${coat}${coat}${coat}${coat}${coat}${coat}${coat}${coat}${coat}${coat}...`,
    `..${coat}${coat}${trim}${coat}${coat}${coat}${coat}${trim}${coat}${coat}${coat}${coat}..`,
    `..${coat}${coat}${trim}${coat}${coat}${coat}${coat}${trim}${coat}${coat}${coat}${coat}..`,
    `..${coat}${coat}${coat}${coat}${coat}${coat}${coat}${coat}${coat}${coat}${coat}${coat}..`,
    `..${coat}${coat}${coat}${coat}${coat}${coat}${coat}${coat}${coat}${coat}${coat}${coat}..`,
    `..${coat}${coat}${coat}${coat}${coat}${coat}${coat}${coat}${coat}${coat}${coat}${coat}..`,
    `...${coat}${coat}${coat}${coat}${coat}${coat}${coat}${coat}${coat}${coat}...`,
    '....11111111....',
    '....1111.111....',
    '....111...11....',
    '....000...00....',
  ]
}

export const SPRITES: Record<string, Art> = {
  // Senior officers wear the darker coat; the clerk wears working dress.
  command: officerSprite('a', 'd'),
  officer: officerSprite('b', 'd'),
  rating: officerSprite('5', '8'),
}
