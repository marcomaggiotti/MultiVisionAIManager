import { MATCH_COLOR, scoreStatus } from "./types";

const RING_RADIUS = 52;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** The live match score as a ring: green from 80 %, yellow from 55 %, red below. */
export function ScoreGauge({ score, label = "Match" }: { score: number | null; label?: string }) {
  const color = MATCH_COLOR[scoreStatus(score)];
  const filled = ((score ?? 0) / 100) * RING_LENGTH;
  return (
    <svg viewBox="0 0 130 130" className="score-gauge" role="img" aria-label={`${label}: ${score == null ? "no score" : `${Math.round(score)} %`}`}>
      <circle cx="65" cy="65" r={RING_RADIUS} fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="12" />
      <circle cx="65" cy="65" r={RING_RADIUS} fill="none" stroke={color} strokeWidth="12" strokeLinecap="round"
        strokeDasharray={`${filled} ${RING_LENGTH}`} transform="rotate(-90 65 65)" style={{ filter: `drop-shadow(0 0 6px ${color})`, transition: "stroke-dasharray .25s, stroke .25s" }} />
      <text x="65" y="68" textAnchor="middle" fontSize="34" fontWeight="800" fill="#e8ecf5">{score == null ? "–" : Math.round(score)}</text>
      <text x="65" y="90" textAnchor="middle" fontSize="12" fill="#8b95ad">{score == null ? label : `% ${label.toLowerCase()}`}</text>
    </svg>
  );
}

/** Score of each compared frame over time, on green / yellow / red bands. */
export function ScoreHistory({ scores, height = 110 }: { scores: (number | null)[]; height?: number }) {
  const width = 600;
  const y = (score: number) => height - (score / 100) * height;
  const x = (index: number) => (scores.length <= 1 ? width : (index / (scores.length - 1)) * width);
  const segments: string[] = [];
  let current = "";
  scores.forEach((score, index) => {
    if (score == null) {
      if (current) segments.push(current);
      current = "";
      return;
    }
    current += `${current ? "L" : "M"}${x(index).toFixed(1)},${y(score).toFixed(1)}`;
  });
  if (current) segments.push(current);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="score-history" role="img" aria-label="Match score over time">
      <rect x="0" y={y(100)} width={width} height={y(80) - y(100)} fill="rgba(61,220,132,.10)" />
      <rect x="0" y={y(80)} width={width} height={y(55) - y(80)} fill="rgba(255,181,71,.09)" />
      <rect x="0" y={y(55)} width={width} height={y(0) - y(55)} fill="rgba(255,93,108,.08)" />
      {segments.map((path, index) => <path key={index} d={path} fill="none" stroke="#e8ecf5" strokeWidth="2" vectorEffect="non-scaling-stroke" />)}
    </svg>
  );
}
