#!/bin/bash
# Installs production dependencies inside each Lambda's own folder so
# CDK's Code.fromAsset() zips a self-contained package per function.
set -euo pipefail
cd "$(dirname "$0")/../lambdas"
for dir in */; do
  echo "Installing deps in $dir"
  (cd "$dir" && npm install --omit=dev)
done
