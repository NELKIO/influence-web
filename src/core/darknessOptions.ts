export interface DarknessOptions {
  darkness: boolean;
  signalFires: boolean;
  blind: boolean;
}

type SavedOptions = Partial<Record<keyof DarknessOptions, unknown>>;

/** Legacy settings have neither experiment; only an explicit boolean opts in. */
export function readDarkness(o: SavedOptions): DarknessOptions {
  const signalFires = o.signalFires === true;
  const blind = o.blind === true;
  return { darkness: o.darkness === true || signalFires || blind, signalFires, blind };
}

/** Keep ordinary matches and online configurations in their historical shape when neither rule is requested. */
export function matchDarkness(o: SavedOptions) {
  const { darkness, signalFires, blind } = readDarkness(o);
  return { darkness, ...(signalFires && { signalFires }), ...(blind && { blind }) };
}
