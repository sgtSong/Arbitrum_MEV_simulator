#!/usr/bin/env python3
import argparse
import json
import glob
from pathlib import Path

import matplotlib.pyplot as plt


def load_transfer_data(data_path: Path) -> dict:
    with data_path.open("r", encoding="utf-8") as f:
        return json.load(f)


def parse_value(value):
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        if value.strip().lower() == "n/a":
            return 0.0
        return float(value)
    return 0.0

def extract_delay_from_data(data):
    # Try to extract delay from known keys
    for key in ("delay_ms", "periodMs"):
        val = data.get(key)
        if val is not None:
            try:
                return float(val)
            except Exception:
                pass
    # Try to extract from filename if possible
    return float("inf")


def load_all_transfer_data(data_dir: Path):
    files = sorted(glob.glob(str(data_dir / "transfer_data*.json")))
    datasets = []
    for f in files:
        data = load_transfer_data(Path(f))
        datasets.append((f, data))
    # Sort by delay
    datasets.sort(key=lambda tup: extract_delay_from_data(tup[1]))
    return datasets


def build_combined_chart(datasets):
    n = len(datasets)
    width = 0.35
    fig, ax = plt.subplots(figsize=(10, 7))
    x_ticks = []
    extractee_losses = []
    extractor_gains = []
    x_labels=["baseline", "330ms", "700ms", "1000ms", "1500ms"]
    # Add extra space between first and second dataset
    gap = 1.2  # controls the width of the gap
    for i, (fname, data) in enumerate(datasets):
        roles = data.get("roles")
        token_in = data.get("avgTokenIn")
        token_out = data.get("avgTokenOut")
        if not (isinstance(roles, list) and isinstance(token_in, list) and isinstance(token_out, list)):
            summary = data.get("summary", {})
            avg = summary.get("avgAmountChart", {})
            sender = avg.get("sender", {})
            receiver = avg.get("receiver", {})
            token_in = [sender.get("tokenIn"), receiver.get("tokenIn")]
            token_out = [sender.get("tokenOut"), receiver.get("tokenOut")]
        token_in = [parse_value(v) for v in token_in]
        token_out = [parse_value(v) for v in token_out]
        # Calculate extractee's loss and extractor's gain
        extractee_loss = token_in[0] - token_out[0]
        extractor_gain = token_out[1] - token_in[1]
        extractee_losses.append(extractee_loss)
        extractor_gains.append(extractor_gain)
        # Custom x-tick positions: add gap after first
        if i == 0:
            x_ticks.append(i)
        else:
            x_ticks.append(x_ticks[-1] + (gap if i == 1 else 1))
    ax.bar([i - width/2 for i in x_ticks], extractee_losses, width, label="Extractee's loss", color="#000000")
    ax.bar([i + width/2 for i in x_ticks], extractor_gains, width, label="Extractor's gain", color="#808080")
    # ax.set_title("Extractee's loss and Extractor's gain vs delay")
    ax.set_xlabel("Submission Gap", fontsize=20, labelpad=20)
    ax.xaxis.set_label_coords(0.6, -0.1)
    # ax.set_ylabel("Transfer Amount")
    ax.set_xticks(x_ticks)
    ax.set_xticklabels(x_labels, rotation=0, fontsize=20)
    ax.legend(loc="upper right", fontsize=20)
    # Remove y-tick guideline
    # ax.grid(axis="y", linestyle="--", alpha=0.25)
    ax.axhline(0, color="black", linewidth=2.5)
    ax.set_ylim(top=8000)
    # Add horizontal dotted line between first and second dataset
    if len(x_ticks) > 1:
        x_sep = (x_ticks[0] + x_ticks[1]) / 2
        ax.axvline(x=x_sep, color="black", linestyle=":", linewidth=2)
        # Add text annotations
        # ax.text(x_sep, ax.get_ylim()[1]*0.70, "No competition", fontsize=16, ha="right", va="top", fontweight="bold", color="#8B0000")
        # ax.text(x_sep + 0.7, ax.get_ylim()[1]*0.70, "With competition", fontsize=16, ha="left", va="top", fontweight="bold", color="#8B0000")
    # Increase y-label and tick font size
    ax.set_ylabel(ax.get_ylabel(), fontsize=20)
    ax.tick_params(axis='y', labelsize=20)
    return fig


def main():
    parser = argparse.ArgumentParser(description="Plot DCAT transfer averages from transfer_data.json")
    parser.add_argument(
        "--data",
        default="/home/ec2-user/DCAT-Sender/data",
        help="Path to a transfer_data JSON file or a directory containing transfer_data*.json",
    )
    parser.add_argument(
        "--outdir",
        default="/home/ec2-user/DCAT-Sender/plots",
        help="Output directory for transfer_amounts.png and transfer_amounts.pdf",
    )
    args = parser.parse_args()

    data_dir = Path(args.data)
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    datasets = load_all_transfer_data(data_dir)
    fig = build_combined_chart(datasets)

    png_path = outdir / "transfer_amounts_combined.png"
    pdf_path = outdir / "transfer_amounts_combined.pdf"

    fig.tight_layout()
    # Save PNG first, then PDF to avoid orientation issues
    fig.savefig(png_path, dpi=200)
    fig.savefig(pdf_path, orientation='portrait')
    plt.close(fig)

    print(f"Loaded {len(datasets)} datasets from {data_dir}")
    print(f"Wrote {png_path} and {pdf_path}")


if __name__ == "__main__":
    main()
