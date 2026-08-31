function round1(value) {
  return Math.round(value * 10) / 10;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function calculateVehicleEta(completedEvents, remainingStops, now = Date.now()) {
  const times = completedEvents.map((event) => Number(event.time)).filter(Number.isFinite).sort((a, b) => a - b);
  const allIntervals = times.slice(1).map((time, index) => (time - times[index]) / 60000).filter((minutes) => minutes >= 2 && minutes <= 240);
  const recentIntervals = allIntervals.slice(-4);
  const overallMedian = median(allIntervals);
  const recentAverage = recentIntervals.length ? recentIntervals.reduce((sum, value) => sum + value, 0) / recentIntervals.length : null;
  const enoughData = times.length >= 3 && allIntervals.length >= 2;
  if (!enoughData || !remainingStops) {
    return {
      avgMinutesPerStop: null,
      recentAvgMinutesPerStop: recentAverage == null ? null : round1(recentAverage),
      overallAvgMinutesPerStop: overallMedian == null ? null : round1(overallMedian),
      remainingMinutes: remainingStops === 0 ? 0 : null,
      estimatedEndAt: null,
      estimateConfidence: remainingStops === 0 ? "완료" : "산출 중"
    };
  }
  const weighted = recentAverage * 0.65 + overallMedian * 0.35;
  const minutesPerStop = Math.min(overallMedian * 1.8, Math.max(overallMedian * 0.5, weighted));
  const remainingMinutes = Math.round(minutesPerStop * remainingStops);
  const baseTime = Math.max(now, times[times.length - 1]);
  return {
    avgMinutesPerStop: round1(minutesPerStop),
    recentAvgMinutesPerStop: round1(recentAverage),
    overallAvgMinutesPerStop: round1(overallMedian),
    remainingMinutes,
    estimatedEndAt: new Date(baseTime + remainingMinutes * 60000).toISOString(),
    estimateConfidence: allIntervals.length >= 4 ? "보통" : "낮음"
  };
}

function isPhoneLike(value) {
  const text = String(value || "").trim();
  const digits = text.replace(/\D/g, "");
  return /^(?:01[016789]|0\d{1,2})[-\s]?\d{3,4}[-\s]?\d{4}$/.test(text) || (digits.length >= 9 && digits.length <= 11 && /^0/.test(digits));
}

export function parseAccessMemo(value) {
  const raw = String(value || "").replace(/\r/g, "").trim();
  if (!raw) return { accessInfo: "", password: "", specialRemark: "" };
  const passwordPattern = /(?:도어락\s*)?(?:비밀번호|출입비번|비번|번호키|보안키|공동현관)\s*(?:[:：=\-]\s*)?([A-Za-z0-9#*\/_-]{2,})/iu;
  const passwordMatch = raw.match(passwordPattern);
  const password = passwordMatch && !isPhoneLike(passwordMatch[1]) ? passwordMatch[1] : "";
  const access = [];
  const notes = [];
  raw.split(/\n|[;；]+/u).map((line) => line.trim()).filter(Boolean).forEach((line) => {
    if (isPhoneLike(line) || /(?:점주|대표|고객)\s*(?:전화|연락처|번호)/u.test(line)) return;
    const cleaned = line.replace(passwordPattern, "").replace(/^[\s,:：=\-]+|[\s,:：=\-]+$/g, "").trim();
    if (/^(?:출입방법|출입정보)\s*[:：]?/u.test(line)) {
      const entry = line.replace(/^(?:출입방법|출입정보)\s*[:：]?\s*/u, "").replace(passwordPattern, "").trim();
      if (entry && !isPhoneLike(entry)) access.push(entry);
    } else if (/^(?:특이사항|메모|비고)\s*[:：]?/u.test(line)) {
      const note = line.replace(/^(?:특이사항|메모|비고)\s*[:：]?\s*/u, "").trim();
      if (note && !isPhoneLike(note)) notes.push(note);
    } else if (/(?:공동현관|도어락|번호키|보안키|경비실|후문|정문)/u.test(line)) {
      if (cleaned && !isPhoneLike(cleaned)) access.push(cleaned);
    } else if (cleaned && cleaned !== password && !isPhoneLike(cleaned)) {
      notes.push(cleaned);
    }
  });
  if (!access.length && !notes.length && !password && !isPhoneLike(raw)) notes.push(raw);
  return {
    accessInfo: [...new Set(access)].join(" · "),
    password,
    specialRemark: [...new Set(notes)].join(" · ")
  };
}
