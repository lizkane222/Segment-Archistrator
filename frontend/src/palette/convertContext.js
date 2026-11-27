import { createContext, useContext } from 'react'

/*
 * Set while a component is being converted: `{ onPick(payload, label), pending }`, else null.
 *
 * A context rather than a prop because the tiles that react to it -- a Segment component, a shape, an
 * icon -- are several components deep and defined in two files; every one of them has to stop being a
 * drag source and become a click target at once, and threading it through each would be six props.
 */
export const ConvertContext = createContext(null)
export const useConvert = () => useContext(ConvertContext)

/* The glow. Shadow rather than a bigger border, so a tile does not change size under the pointer. */
export const GLOW_CLASS =
  'border-twilio-blue shadow-[0_0_0_2px_rgba(2,99,224,0.35),0_0_10px_2px_rgba(2,99,224,0.55)]'
export const GLOW_PENDING_CLASS =
  'border-twilio-blue bg-twilio-blue-light shadow-[0_0_0_2px_rgba(2,99,224,0.9),0_0_14px_3px_rgba(2,99,224,0.7)]'
