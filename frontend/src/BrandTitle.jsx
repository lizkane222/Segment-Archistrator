/*
 * The "Archistrator" title in the top-left of the header.
 *
 * Several looks to try. To switch, change which `export default` line at the bottom is
 * uncommented (exactly one should be active). Each look is its own small component above it.
 *
 * Logo colours, read off the cursive "a": the blue at the top of the stroke and the purple at the
 * bottom. Tweak these two to retune every option at once.
 */

const LOGO_BLUE = '#4A90FF'
const LOGO_PURPLE = '#7C4DFF'

const BASE = 'text-sm font-semibold'

/* Mix two #rrggbb colours; t = 0 gives `from`, t = 1 gives `to`. */
function mix(from, to, t) {
  const a = from.match(/\w\w/g).map((h) => parseInt(h, 16))
  const b = to.match(/\w\w/g).map((h) => parseInt(h, 16))
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t))
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}

/* 1. black -- the original. */
function BlackTitle() {
  return <span className={`${BASE} text-twilio-navy`}>Archistrator</span>
}

/* 2. purple -- the logo's purple, flat. */
function PurpleTitle() {
  return (
    <span className={BASE} style={{ color: LOGO_PURPLE }}>
      archistrator
    </span>
  )
}

/* 3. blue -- the logo's blue, flat. */
function BlueTitle() {
  return (
    <span className={BASE} style={{ color: LOGO_BLUE }}>
      archistrator
    </span>
  )
}

/* 4. gradient -- one blue-to-purple gradient running across the whole word. */
function GradientTitle() {
  return (
    <span
      className={BASE}
      style={{
        backgroundImage: `linear-gradient(90deg, ${LOGO_BLUE}, ${LOGO_PURPLE})`,
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        color: 'transparent',
      }}
    >
      archistrator
    </span>
  )
}

/* 5. per-letter -- each letter takes its own step along the blue-to-purple range. */
function PerLetterTitle() {
  const word = 'archistrator'
  return (
    <span className={BASE} aria-label={word}>
      {[...word].map((ch, i) => (
        <span
          key={i}
          aria-hidden="true"
          style={{ color: mix(LOGO_BLUE, LOGO_PURPLE, i / (word.length - 1)) }}
        >
          {ch}
        </span>
      ))}
    </span>
  )
}

/* ---- Pick one: uncomment exactly one line. ---- */
// export default BlackTitle
// export default PurpleTitle
// export default BlueTitle
export default GradientTitle
// export default PerLetterTitle
