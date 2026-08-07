# Theme Colors

Source of truth: `app/src/theme/tokens.ts`. Brand identity is **navy** `#19294E` / `#1F3566` and **gold** `#F0BC25` / `#F5C542`.

---

## Brand constants (fixed — not themeable)

Used only on OAuth sign-in buttons. Never used as app UI tokens.

| Token | Hex |
|---|---|
| `BRAND.google` | `#4285F4` |
| `BRAND.discord` | `#5865F2` |
| `BRAND.github` | `#24292E` |
| `BRAND.onBrand` | `#FFFFFF` |

---

## Shared palettes

### Chart colors (`chart`)

Same hue order in every theme. Light themes use **Chart Light**; dark themes use **Chart Dark** (each hue ~15% brighter).

**Chart Light** (White, Gold Light)

| # | Hex |
|---|---|
| 0 | `#4F8CFF` |
| 1 | `#81C995` |
| 2 | `#F0A868` |
| 3 | `#C58AF9` |
| 4 | `#FF8A80` |
| 5 | `#4DD0E1` |
| 6 | `#D4B106` |
| 7 | `#A1887F` |
| 8 | `#90A4AE` |
| 9 | `#CE93D8` |

**Chart Dark** (Black, Navy, Gold Dark)

| # | Hex |
|---|---|
| 0 | `#699DFF` |
| 1 | `#94D1A5` |
| 2 | `#F2B57F` |
| 3 | `#CE9CFA` |
| 4 | `#FF9C93` |
| 5 | `#68D7E6` |
| 6 | `#DABD2B` |
| 7 | `#AF9A92` |
| 8 | `#A1B2BA` |
| 9 | `#D5A3DE` |

### Field chip colors (`fieldChip`)

Capture-screen Store / Total / Date / Time markers.

**Field Light** (White, Gold Light)

| Field | Hex |
|---|---|
| store | `#3B5BDB` |
| total | `#2F9E44` |
| date | `#E8710A` |
| time | `#9334E6` |

**Field Dark** (Black, Navy, Gold Dark)

| Field | Hex |
|---|---|
| store | `#5C7CFA` |
| total | `#51CF66` |
| date | `#FFA94D` |
| time | `#B197FC` |

---

## White

Light neutral default. Accent: brand navy.

| Token | Hex |
|---|---|
| `scheme` | light |
| `background` | `#FFFFFF` |
| `surface` | `#F4F5F7` |
| `surfaceElevated` | `#FFFFFF` |
| `border` | `#D8DBE0` |
| `borderStrong` | `#8A909C` |
| `textPrimary` | `#14181F` |
| `textSecondary` | `#5B6472` |
| `textOnAccent` | `#FFFFFF` |
| `accent` | `#1F3566` |
| `accentSurface` | `rgba(31,53,102,0.10)` |
| `success` | `#1E8E5A` |
| `warning` | `#B7791F` |
| `danger` | `#C62828` |
| `scrim` | `rgba(0,0,0,0.45)` |
| `chart` | Chart Light |
| `chartAxis` | `#5B6472` |
| `chartGrid` | `#D8DBE0` |
| `fieldChip` | Field Light |

---

## Black

Dark neutral counterpart. Accent: brand gold.

| Token | Hex |
|---|---|
| `scheme` | dark |
| `background` | `#121417` |
| `surface` | `#1C1F24` |
| `surfaceElevated` | `#24282E` |
| `border` | `#33373F` |
| `borderStrong` | `#6B7280` |
| `textPrimary` | `#F2F3F5` |
| `textSecondary` | `#A8AEB8` |
| `textOnAccent` | `#1A2340` |
| `accent` | `#F0BC25` |
| `accentSurface` | `rgba(240,188,37,0.14)` |
| `success` | `#4CD07D` |
| `warning` | `#F2A93C` |
| `danger` | `#FF6B6B` |
| `scrim` | `rgba(0,0,0,0.60)` |
| `chart` | Chart Dark |
| `chartAxis` | `#A8AEB8` |
| `chartGrid` | `#33373F` |
| `fieldChip` | Field Dark |

---

## Navy

Flagship brand-dark — logo colors as the app skin. Accent: brand gold.

| Token | Hex |
|---|---|
| `scheme` | dark |
| `background` | `#16233F` |
| `surface` | `#1D2E52` |
| `surfaceElevated` | `#24386A` |
| `border` | `#34456F` |
| `borderStrong` | `#6E7FA6` |
| `textPrimary` | `#F3EAD2` |
| `textSecondary` | `#ABB6CC` |
| `textOnAccent` | `#1A2340` |
| `accent` | `#F0BC25` |
| `accentSurface` | `rgba(240,188,37,0.14)` |
| `success` | `#59D68B` |
| `warning` | `#FFC15E` |
| `danger` | `#FF7A7A` |
| `scrim` | `rgba(0,0,0,0.55)` |
| `chart` | Chart Dark |
| `chartAxis` | `#ABB6CC` |
| `chartGrid` | `#34456F` |
| `fieldChip` | Field Dark |

---

## Gold Light

Flagship brand-light — warm cream (matches app icon background). Accent: brand navy.

| Token | Hex |
|---|---|
| `scheme` | light |
| `background` | `#FBF1DC` |
| `surface` | `#FFF8EA` |
| `surfaceElevated` | `#FFFFFF` |
| `border` | `#E7D8AE` |
| `borderStrong` | `#8C7A4A` |
| `textPrimary` | `#19294E` |
| `textSecondary` | `#5A6478` |
| `textOnAccent` | `#FFFFFF` |
| `accent` | `#19294E` |
| `accentSurface` | `rgba(25,41,78,0.10)` |
| `success` | `#1E8E5A` |
| `warning` | `#B7791F` |
| `danger` | `#C62828` |
| `scrim` | `rgba(0,0,0,0.45)` |
| `chart` | Chart Light |
| `chartAxis` | `#5A6478` |
| `chartGrid` | `#E7D8AE` |
| `fieldChip` | Field Light |

---

## Gold Dark

Premium warm-dark with the brightest gold accent.

| Token | Hex |
|---|---|
| `scheme` | dark |
| `background` | `#1A1508` |
| `surface` | `#241D0E` |
| `surfaceElevated` | `#2E2512` |
| `border` | `#4A3B1C` |
| `borderStrong` | `#7A6636` |
| `textPrimary` | `#FBF1DC` |
| `textSecondary` | `#C9B888` |
| `textOnAccent` | `#1A1508` |
| `accent` | `#F5C542` |
| `accentSurface` | `rgba(245,197,66,0.14)` |
| `success` | `#59D68B` |
| `warning` | `#FFC15E` |
| `danger` | `#FF7A7A` |
| `scrim` | `rgba(0,0,0,0.60)` |
| `chart` | Chart Dark |
| `chartAxis` | `#C9B888` |
| `chartGrid` | `#4A3B1C` |
| `fieldChip` | Field Dark |

---

## System

Not a separate palette. Resolves at runtime:

- OS light mode → **White**
- OS dark mode → **Black**
