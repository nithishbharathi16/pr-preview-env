#!/bin/bash
# Reference copy of the script the provisioner Lambda generates and injects
# as EC2 user-data. Kept here for documentation/testing outside Lambda.
#
# Usage (generated dynamically per PR):
#   REPO=<owner/repo> BRANCH=<branch> SHA=<commit-sha>
set -euxo pipefail

REPO="${REPO:?set REPO}"
BRANCH="${BRANCH:?set BRANCH}"
SHA="${SHA:?set SHA}"

dnf install -y git nodejs

cd /home/ec2-user
git clone --branch "$BRANCH" --depth 1 "https://github.com/${REPO}.git" app
cd app
git checkout "$SHA"
npm install --omit=dev

# Replace with your app's actual start command / port.
nohup npm start > /var/log/preview-app.log 2>&1 &
