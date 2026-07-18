import React, { useState, useEffect, useCallback, useMemo } from "react";
import Plot from "react-plotly.js";
import DatePicker from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";
import { supabase } from "./supabaseClient";

// Cap rendered points so very long ranges (24h ≈ 850k+ samples) don't freeze
// the browser. Set high enough that typical ranges render at full 10 Hz
// resolution: ~50k points covers ~1.4 hours of continuous 10 Hz data before any
// decimation kicks in. WebGL (scattergl) handles this comfortably; only
// multi-hour / full-day ranges get thinned to the min/max envelope.
const MAX_POINTS = 50000;

// Bucket the series and keep, per bucket, BOTH the lowest and highest sample
// (emitted in time order). This preserves the true top-and-bottom envelope of
// the signal, so an oscillating waveform looks the same zoomed out as it would
// with every point plotted — no one-sided bias. Null gap-markers are passed
// through so Plotly still breaks the line across time gaps.
function decimateMinMax(times, values, maxPoints) {
  const n = values.length;
  if (n <= maxPoints) return { t: times, v: values };
  const t = [];
  const v = [];
  // Each bucket emits up to 2 points (min + max), so use half as many buckets
  // to land near the maxPoints budget.
  const buckets = Math.max(1, Math.floor(maxPoints / 2));
  const bucketSize = n / buckets;
  for (let i = 0; i < buckets; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.min(Math.floor((i + 1) * bucketSize), n);
    let minIdx = -1;
    let maxIdx = -1;
    let minVal = Infinity;
    let maxVal = -Infinity;
    let nullIdx = -1;
    for (let j = start; j < end; j++) {
      const val = values[j];
      if (val === null) {
        nullIdx = j;
        continue;
      }
      if (val < minVal) {
        minVal = val;
        minIdx = j;
      }
      if (val > maxVal) {
        maxVal = val;
        maxIdx = j;
      }
    }
    // Emit picks ordered by original index so time stays monotonic and any
    // gap-break (null) lands in the right place.
    const picks = [];
    if (minIdx !== -1) picks.push(minIdx);
    if (maxIdx !== -1 && maxIdx !== minIdx) picks.push(maxIdx);
    if (nullIdx !== -1) picks.push(nullIdx);
    picks.sort((a, b) => a - b);
    for (const idx of picks) {
      t.push(times[idx]);
      v.push(values[idx]);
    }
  }
  return { t, v };
}

// Build Plotly traces for vibration data. Each row has 500 samples; insert null
// gaps between batches so Plotly doesn't draw lines across time gaps.
//
// viewRange (optional [startMs, endMs]) limits the build to the currently
// visible time window. When the user zooms in, only that window's raw samples
// are built — so a small window falls under MAX_POINTS and renders at full
// 10 Hz resolution even inside a huge (e.g. 24h) load. Passing null builds the
// whole dataset (decimated to the envelope).
function buildVibrationTraces(rows, viewRange) {
  if (rows.length === 0) {
    return { x: { t: [], v: [] }, z: { t: [], v: [] }, count: 0 };
  }

  // Keep only rows whose 50s span overlaps the visible window (plus the whole
  // boundary rows, so lines reach the chart edges).
  let workingRows = rows;
  if (viewRange) {
    const [vs, ve] = viewRange;
    workingRows = rows.filter((row) => {
      const s = new Date(row.timestamp).getTime();
      const e = s + row.x_values.length * 100;
      return e >= vs && s <= ve;
    });
  }

  if (workingRows.length === 0) {
    return { x: { t: [], v: [] }, z: { t: [], v: [] }, count: 0 };
  }

  const xAll = [];
  const zAll = [];
  const timeAll = [];

  let prevBatchEnd = 0;

  for (const row of workingRows) {
    const batchTime = new Date(row.timestamp).getTime();
    const sampleCount = row.x_values.length;

    // If there's a gap > 5 seconds from the previous batch, insert a null
    // to break the line
    if (prevBatchEnd > 0 && batchTime - prevBatchEnd > 5000) {
      timeAll.push(new Date(prevBatchEnd + 1));
      xAll.push(null);
      zAll.push(null);
    }

    // 10 Hz sampling = 100ms per sample, so 500 samples spans 50 seconds
    const sampleIntervalMs = 100;
    for (let i = 0; i < sampleCount; i++) {
      const t = new Date(batchTime + i * sampleIntervalMs);
      timeAll.push(t);
      xAll.push(row.x_values[i]);
      zAll.push(row.z_values[i]);
    }

    prevBatchEnd = batchTime + sampleCount * sampleIntervalMs;
  }

  return {
    x: decimateMinMax(timeAll, xAll, MAX_POINTS),
    z: decimateMinMax(timeAll, zAll, MAX_POINTS),
    count: timeAll.length,
  };
}

function App() {
  const [devices, setDevices] = useState([]);
  const [selectedDevice, setSelectedDevice] = useState("");
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setHours(d.getHours() - 24);
    return d;
  });
  const [endDate, setEndDate] = useState(new Date());
  const [vibrationData, setVibrationData] = useState([]);
  const [heartbeats, setHeartbeats] = useState([]);
  const [loading, setLoading] = useState(false);
  // Currently visible time window [startMs, endMs], or null for the full range.
  // Driven by chart zoom/pan so we can re-render the visible slice at full res.
  const [viewRange, setViewRange] = useState(null);

  // Fetch device list on mount
  useEffect(() => {
    async function fetchDevices() {
      const { data, error } = await supabase
        .from("devices")
        .select("id, name")
        .order("id");
      if (error) {
        console.error("Error fetching devices:", error);
        return;
      }
      setDevices(data || []);
      if (data && data.length > 0) {
        setSelectedDevice(data[0].id);
      }
    }
    fetchDevices();
  }, []);

  const fetchData = useCallback(async () => {
    if (!selectedDevice) return;
    setLoading(true);

    const start = startDate.toISOString();
    const end = endDate.toISOString();

    // Paginated fetch — Supabase caps at 1000 rows per request
    async function fetchAll(table, columns) {
      const pageSize = 1000;
      let allData = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from(table)
          .select(columns)
          .eq("device_id", selectedDevice)
          .gte("timestamp", start)
          .lte("timestamp", end)
          .order("timestamp", { ascending: true })
          .range(from, from + pageSize - 1);
        if (error) {
          console.error(`${table} query error:`, error);
          break;
        }
        allData = allData.concat(data);
        if (data.length < pageSize) break;
        from += pageSize;
      }
      return allData;
    }

    const [vibData, hbData] = await Promise.all([
      fetchAll("vibration_data", "timestamp, x_values, z_values"),
      fetchAll("heartbeats", "timestamp, battery_pct"),
    ]);

    setViewRange(null); // reset zoom when a fresh range is loaded
    setVibrationData(vibData);
    setHeartbeats(hbData);
    setLoading(false);
  }, [selectedDevice, startDate, endDate]);

  // Memoized so traces are only rebuilt when the data or the visible window
  // changes, not on every render. Zooming updates viewRange, which re-renders
  // just the visible slice at full resolution.
  const vibTraces = useMemo(
    () => buildVibrationTraces(vibrationData, viewRange),
    [vibrationData, viewRange]
  );

  // Sync the visible window from chart zoom/pan. Both charts share one range so
  // they stay aligned. Double-click (autorange) clears it back to the full view.
  const handleRelayout = useCallback((e) => {
    if (!e) return;
    if (e["xaxis.autorange"]) {
      setViewRange(null);
      return;
    }
    const r0 = e["xaxis.range[0]"];
    const r1 = e["xaxis.range[1]"];
    if (r0 == null || r1 == null) return;
    const s = new Date(r0).getTime();
    const en = new Date(r1).getTime();
    setViewRange((prev) => {
      // Skip no-op updates (e.g. the programmatic relayout we trigger below)
      // so we don't loop.
      if (prev && Math.abs(prev[0] - s) < 1 && Math.abs(prev[1] - en) < 1) {
        return prev;
      }
      return [s, en];
    });
  }, []);

  // Applied to each chart's xaxis so both charts follow the shared zoom window.
  const xAxisRange = viewRange
    ? { range: [new Date(viewRange[0]), new Date(viewRange[1])], autorange: false }
    : {};

  return (
    <div className="app">
      <h1>Inertia Monitoring Dashboard</h1>

      <div className="controls">
        <label>
          Device
          <select
            value={selectedDevice}
            onChange={(e) => setSelectedDevice(e.target.value)}
          >
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          Start
          <DatePicker
            selected={startDate}
            onChange={setStartDate}
            showTimeSelect
            dateFormat="yyyy-MM-dd HH:mm"
            timeFormat="HH:mm"
          />
        </label>

        <label>
          End
          <DatePicker
            selected={endDate}
            onChange={setEndDate}
            showTimeSelect
            dateFormat="yyyy-MM-dd HH:mm"
            timeFormat="HH:mm"
          />
        </label>

        <button onClick={fetchData} disabled={loading || !selectedDevice}>
          {loading ? "Loading..." : "Load Data"}
        </button>
      </div>

      {/* X-axis vibration */}
      <div className="chart-section">
        <h2>X-Axis Vibration</h2>
        {vibTraces.count > 0 ? (
          <Plot
            data={[
              {
                x: vibTraces.x.t,
                y: vibTraces.x.v,
                type: "scattergl",
                mode: "lines",
                name: "X accel",
                line: { color: "#3b82f6", width: 1 },
              },
            ]}
            layout={{
              paper_bgcolor: "transparent",
              plot_bgcolor: "#0f172a",
              font: { color: "#94a3b8" },
              xaxis: { title: "Time", gridcolor: "#1e293b", ...xAxisRange },
              yaxis: { title: "Acceleration (m/s²)", gridcolor: "#1e293b" },
              margin: { t: 20, r: 20, b: 50, l: 60 },
              height: 300,
            }}
            onRelayout={handleRelayout}
            config={{ responsive: true, scrollZoom: true }}
            style={{ width: "100%" }}
          />
        ) : (
          <p className="status">
            {loading ? "Loading..." : "No data. Select a device and time range, then click Load Data."}
          </p>
        )}
      </div>

      {/* Z-axis vibration */}
      <div className="chart-section">
        <h2>Z-Axis Vibration</h2>
        {vibTraces.count > 0 ? (
          <Plot
            data={[
              {
                x: vibTraces.z.t,
                y: vibTraces.z.v,
                type: "scattergl",
                mode: "lines",
                name: "Z accel",
                line: { color: "#10b981", width: 1 },
              },
            ]}
            layout={{
              paper_bgcolor: "transparent",
              plot_bgcolor: "#0f172a",
              font: { color: "#94a3b8" },
              xaxis: { title: "Time", gridcolor: "#1e293b", ...xAxisRange },
              yaxis: { title: "Acceleration (m/s²)", gridcolor: "#1e293b" },
              margin: { t: 20, r: 20, b: 50, l: 60 },
              height: 300,
            }}
            onRelayout={handleRelayout}
            config={{ responsive: true, scrollZoom: true }}
            style={{ width: "100%" }}
          />
        ) : (
          <p className="status">No Z-axis data.</p>
        )}
      </div>

      {/* Battery history */}
      <div className="chart-section">
        <h2>Battery History</h2>
        {heartbeats.length > 0 ? (
          <Plot
            data={[
              {
                x: heartbeats.map((h) => new Date(h.timestamp)),
                y: heartbeats.map((h) => h.battery_pct),
                type: "scatter",
                mode: "lines+markers",
                name: "Battery %",
                line: { color: "#f59e0b", width: 2 },
                marker: { size: 4 },
              },
            ]}
            layout={{
              paper_bgcolor: "transparent",
              plot_bgcolor: "#0f172a",
              font: { color: "#94a3b8" },
              xaxis: { title: "Time", gridcolor: "#1e293b" },
              yaxis: {
                title: "Battery %",
                range: [0, 100],
                gridcolor: "#1e293b",
              },
              margin: { t: 20, r: 20, b: 50, l: 60 },
              height: 250,
            }}
            config={{ responsive: true, scrollZoom: true }}
            style={{ width: "100%" }}
          />
        ) : (
          <p className="status">No heartbeat data.</p>
        )}
      </div>
    </div>
  );
}

export default App;
