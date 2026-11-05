// Piece sets. A set turns (color, type) into a CSS image URL. Sets are folders
// of images in public/pieces/<id>/ named wK.svg, bN.svg, ...

export type PieceColor = "w" | "b";
export type PieceType = "p" | "n" | "b" | "r" | "q" | "k";

export interface PieceSet {
  id: string;
  name: string;
  url(color: PieceColor, type: PieceType): string;
}

export function imageFolderSet(id: string, name: string, folder: string, ext = "svg"): PieceSet {
  return {
    id,
    name,
    url: (color, type) => `url("${folder}/${color}${type.toUpperCase()}.${ext}")`,
  };
}

/** Standard pieces by Cburnett, from Wikimedia Commons (BSD license; see public/pieces/cburnett/LICENSE.txt). */
export const CBURNETT = imageFolderSet("cburnett", "Cburnett", "/pieces/cburnett");
