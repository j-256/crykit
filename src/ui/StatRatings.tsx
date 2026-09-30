import { Brain, Clover, Crosshair, Droplets, Feather, Heart, Shield, Sparkles, Sword, Timer, type LucideIcon } from 'lucide-react'
import { useId } from 'react'
import { STAT_KEYS, type GrowthStat } from '../domain/crystal-edit'
import { CLASS_RATING_STARS, CLASS_STAT_LABELS, statRatingValues } from '../domain/stat-ratings'
import ratingUrl from '../assets/ratings/job-rating.png?url&no-inline'

const STAT_ICONS: Readonly<Record<GrowthStat, LucideIcon>> = Object.freeze({ HP: Heart, MP: Droplets, STR: Sword, VIT: Shield, DEX: Crosshair, AGI: Feather, MND: Brain, SPI: Sparkles, SPD: Timer, LUK: Clover })
const STAR_SIZE = 16
const STAR_SOURCE_SIZE = 28
const STAR_SHEET_WIDTH = 64
const STAR_SHEET_HEIGHT = 32
const STAR_SCALE = STAR_SIZE / STAR_SOURCE_SIZE
const FILLED_STAR_SOURCE_X = 2
const EMPTY_STAR_SOURCE_X = 34
const STAR_SOURCE_Y = 2
const EXTRA_STAT_ICONS: Readonly<Record<string, LucideIcon>> = Object.freeze({ attack: Sword, defense: Shield, resistance: Sparkles, accuracy: Crosshair, evasion: Feather })
const STAT_COLORS: Readonly<Record<GrowthStat, readonly [number, number, number]>> = Object.freeze({ HP: [105, 179, 47], MP: [32, 190, 250], STR: [255, 128, 128], VIT: [255, 255, 128], DEX: [192, 128, 255], AGI: [128, 255, 128], MND: [128, 255, 255], SPI: [255, 128, 192], SPD: [128, 128, 255], LUK: [255, 192, 128] })

export function StatLabel({ label }: { label: string }) {
  const normalized = label.toLowerCase()
  const stat = STAT_KEYS.find(stat => stat.toLowerCase() === normalized || CLASS_STAT_LABELS[stat].toLowerCase() === normalized)
  const StatIcon = stat ? STAT_ICONS[stat] : EXTRA_STAT_ICONS[normalized]
  return <span className="stat-label">{StatIcon && <StatIcon aria-hidden="true" size={14}/>}<span>{label}</span></span>
}

export function RatingStars({ value, tintId }: { value: number | null; tintId: string }) {
  if (value === null) return <span className="stat-rating__unknown">Unknown</span>
  const label = `${value} of ${CLASS_RATING_STARS} stars`
  if (value > CLASS_RATING_STARS) return <span>{value} stars (above standard scale)</span>
  const displayed = Math.ceil(value * 2) / 2
  const style = { backgroundImage: `url(${ratingUrl})`, backgroundSize: `${STAR_SHEET_WIDTH * STAR_SCALE}px ${STAR_SHEET_HEIGHT * STAR_SCALE}px` }
  return <span aria-label={label} className="rating-stars" role="img" title={label}>{Array.from({ length: CLASS_RATING_STARS }, (_, index) => <span aria-hidden="true" className="rating-stars__star" key={index} style={{ ...style, backgroundPosition: `${-EMPTY_STAR_SOURCE_X * STAR_SCALE}px ${-STAR_SOURCE_Y * STAR_SCALE}px` }}><span className="rating-stars__fill" style={{ ...style, width: `${Math.max(0, Math.min(1, displayed - index)) * 100}%`, backgroundPosition: `${-FILLED_STAR_SOURCE_X * STAR_SCALE}px ${-STAR_SOURCE_Y * STAR_SCALE}px`, filter: `url(#${tintId})` }}/></span>)}</span>
}

export function StatRatings({ field, value }: { field: string; value: unknown }) {
  const id = useId()
  const ratings = statRatingValues(field, value)
  return <><svg aria-hidden="true" className="rating-filters" height="0" width="0"><defs>{STAT_KEYS.map(stat => {
    const [red, green, blue] = STAT_COLORS[stat]
    return <filter colorInterpolationFilters="sRGB" id={`${id}-${stat}`} key={stat}><feColorMatrix type="matrix" values={`${red / 255} 0 0 0 0 0 ${green / 255} 0 0 0 0 0 ${blue / 255} 0 0 0 0 0 1 0`}/></filter>
  })}</defs></svg><dl className="stat-ratings">{STAT_KEYS.map(stat => {
    const StatIcon = STAT_ICONS[stat]
    return <div className="stat-rating" key={stat}><dt><StatIcon aria-hidden="true" size={14} style={{ color: `rgb(${STAT_COLORS[stat].join(',')})` }}/><abbr title={CLASS_STAT_LABELS[stat]}>{stat}</abbr></dt><dd><RatingStars tintId={`${id}-${stat}`} value={ratings[stat]}/></dd></div>
  })}</dl></>
}
