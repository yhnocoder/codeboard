/** The page's own classes for the editor's menus, floating bars and buttons, so they look like the rest of its UI.
 *  They are added next to the package's md-menu / md-bar / md-btn, which the package's stylesheet only sizes and lays out */
export type MdClasses = { menu?: string; bar?: string; button?: string };

const OWN = { menu: "md-menu", bar: "md-bar", button: "md-btn" } as const;

export const kindClass = (c: MdClasses | undefined, k: keyof MdClasses) => (c?.[k] ? `${OWN[k]} ${c[k]}` : OWN[k]);
