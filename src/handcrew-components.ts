import { createComponent } from '@iwsdk/core';

/** Tag: a role core on the workbench that forges an agent when dropped on the forge. */
export const CoreTag = createComponent('HandcrewCore', {});
/** Tag: a spawned agent character. */
export const AgentTag = createComponent('HandcrewAgent', {});
/** Tag: a task card that starts a run when dropped onto an agent. */
export const CardTag = createComponent('HandcrewCard', {});
/** Tag: a pressable desk button (approve / reject / reset). */
export const ButtonTag = createComponent('HandcrewButton', {});
