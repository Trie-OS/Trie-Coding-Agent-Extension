/** Injected into chat prompts so local models stay plain-text professional. */
export const NO_EMOJIS_INSTRUCTION = 'Do not use emojis in responses.'

/** Small models grep literally unless told otherwise — steer them toward intent. */
export const INTERPRET_USER_INTENT_INSTRUCTION =
  'User messages may contain typos or informal phrasing. Infer what they likely meant before searching or editing — do not grep for misspelled fragments from their text. Search for real code terms (identifiers, API names, English words) that match the inferred intent.'
