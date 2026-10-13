import { z } from "zod";

// a player's look: the fields the game's character creator sets (buildFigure in the client turns them into a scout)
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const HAIR_STYLES = ["short", "fade", "messy", "curly", "bald", "afro", "locs", "long", "ponytail", "bob", "bun", "braids"] as const;
export const Character = z.object({
  female: z.boolean().optional(),
  build: z.number().min(.85).max(1.2).optional(),
  skin: hex.optional(), hair: hex.optional(), eye: hex.optional(),
  hairStyle: z.enum(HAIR_STYLES).optional(),
  outfit: z.enum(["jacket", "tee", "dress"]).optional(),
  shirt: hex.optional(), pants: hex.optional(), boots: hex.optional(),
  hat: z.boolean().optional(), shades: z.boolean().optional(),
}).strict();
export type CharacterT = z.infer<typeof Character>;
