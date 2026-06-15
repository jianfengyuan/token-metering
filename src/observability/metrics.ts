type LabelValue = string | number | boolean;
type Labels = Record<string, LabelValue | undefined>;

interface MetricSample {
  labels: Record<string, string>;
  value: number;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function normalizeLabelValue(value: LabelValue | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return String(value);
}

function normalizeLabels(labels: Labels): Record<string, string> {
  const normalizedEntries = Object.entries(labels)
    .map(([key, value]) => [key, normalizeLabelValue(value)] as const)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, value ?? ""]);
  return Object.fromEntries(normalizedEntries);
}

function labelKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join("|");
}

function formatLabelSet(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return "";
  }
  const text = entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",");
  return `{${text}}`;
}

class CounterMetric {
  constructor(
    public readonly name: string,
    public readonly help: string
  ) {}

  private readonly values = new Map<string, MetricSample>();

  inc(labels: Labels = {}, value = 1): void {
    const normalized = normalizeLabels(labels);
    const key = labelKey(normalized);
    const current = this.values.get(key);
    if (current) {
      current.value += value;
      return;
    }
    this.values.set(key, { labels: normalized, value });
  }

  reset(): void {
    this.values.clear();
  }

  render(): string[] {
    const lines: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const sample of this.values.values()) {
      lines.push(`${this.name}${formatLabelSet(sample.labels)} ${sample.value}`);
    }
    return lines;
  }
}

class HistogramMetric {
  constructor(
    public readonly name: string,
    public readonly help: string,
    private readonly buckets: number[]
  ) {}

  private readonly values = new Map<
    string,
    {
      labels: Record<string, string>;
      bucketCounts: number[];
      sum: number;
      count: number;
    }
  >();

  observe(value: number, labels: Labels = {}): void {
    const normalized = normalizeLabels(labels);
    const key = labelKey(normalized);
    let sample = this.values.get(key);
    if (!sample) {
      sample = {
        labels: normalized,
        bucketCounts: new Array(this.buckets.length).fill(0),
        sum: 0,
        count: 0
      };
      this.values.set(key, sample);
    }
    sample.sum += value;
    sample.count += 1;
    this.buckets.forEach((bucket, index) => {
      if (value <= bucket) {
        sample.bucketCounts[index] += 1;
      }
    });
  }

  reset(): void {
    this.values.clear();
  }

  render(): string[] {
    const lines: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const sample of this.values.values()) {
      this.buckets.forEach((bucket, index) => {
        lines.push(
          `${this.name}_bucket${formatLabelSet({ ...sample.labels, le: String(bucket) })} ${sample.bucketCounts[index]}`
        );
      });
      lines.push(`${this.name}_bucket${formatLabelSet({ ...sample.labels, le: "+Inf" })} ${sample.count}`);
      lines.push(`${this.name}_sum${formatLabelSet(sample.labels)} ${sample.sum}`);
      lines.push(`${this.name}_count${formatLabelSet(sample.labels)} ${sample.count}`);
    }
    return lines;
  }
}

const defaultLatencyBucketsMs = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000];

const counters = {
  httpRequestsTotal: new CounterMetric("tm_http_requests_total", "Total HTTP requests"),
  chatRequestsTotal: new CounterMetric("tm_chat_requests_total", "Total chat requests by outcome"),
  providerRetriesTotal: new CounterMetric("tm_provider_retries_total", "Provider retries"),
  providerFailoversTotal: new CounterMetric("tm_provider_failovers_total", "Provider failovers"),
  auditEventsTotal: new CounterMetric("tm_audit_events_total", "Audit events written")
};

const histograms = {
  httpRequestDurationMs: new HistogramMetric(
    "tm_http_request_duration_ms",
    "HTTP request latency in milliseconds",
    defaultLatencyBucketsMs
  ),
  providerCallDurationMs: new HistogramMetric(
    "tm_provider_call_duration_ms",
    "Provider call latency in milliseconds",
    defaultLatencyBucketsMs
  )
};

export const metrics = {
  ...counters,
  ...histograms,
  renderPrometheus(): string {
    const lines = [
      ...counters.httpRequestsTotal.render(),
      ...histograms.httpRequestDurationMs.render(),
      ...counters.chatRequestsTotal.render(),
      ...histograms.providerCallDurationMs.render(),
      ...counters.providerRetriesTotal.render(),
      ...counters.providerFailoversTotal.render(),
      ...counters.auditEventsTotal.render()
    ];
    return `${lines.join("\n")}\n`;
  },
  resetForTests(): void {
    counters.httpRequestsTotal.reset();
    counters.chatRequestsTotal.reset();
    counters.providerRetriesTotal.reset();
    counters.providerFailoversTotal.reset();
    counters.auditEventsTotal.reset();
    histograms.httpRequestDurationMs.reset();
    histograms.providerCallDurationMs.reset();
  }
};
