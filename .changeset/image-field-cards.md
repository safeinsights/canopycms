---
'canopycms': minor
---

### Image fields are bordered cards, and Crop explains itself and works without `aspect`

<!-- migration
area: Editing
action: None
row: Image field card; Crop disabled with reason; free-form crop
-->

**What changed.** An image field is now a bordered card: the label row holds Replace, Crop and Remove, so each action sits with its image, and the thumbnail and alt text sit inside. Crop stays visible when it can't apply and says why on hover, focus and touch: a file outside the media library, or an SVG. A read-only form omits it. A field without `aspect` no longer hides Crop: a pick isn't cropped, and Crop afterwards is a free-form rectangle of any shape. A field with `aspect` still crops on pick, locked to that shape; a picked SVG now commits without a crop step. Applying a crop that covers the whole frame stores no crop, which is also how to take one off. The crop step uses `react-image-crop` (ISC) in place of `react-easy-crop`, so it has no zoom slider: resize the box instead. A field's label row now wraps its actions under the label on a narrow form, instead of squeezing the label. The stored `crop` and `width`/`height` are unchanged.

**To adopt.** Nothing. `canopycms/client` now imports `react-image-crop`'s stylesheet through the editor theme, so a bundler that handles the Mantine stylesheets handles it too.
