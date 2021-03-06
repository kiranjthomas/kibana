#!/usr/bin/env bash

set -e

function report {
  if [[ -z "$PR_SOURCE_BRANCH" ]]; then
    cd "$KIBANA_DIR"
    node src/dev/failed_tests/cli
  else
    echo "Failure issues not created on pull requests"
  fi
}

trap report EXIT

export TEST_BROWSER_HEADLESS=1

echo " -> Running mocha tests"
cd "$XPACK_DIR"
checks-reporter-with-killswitch "X-Pack Mocha" yarn test
echo ""
echo ""

echo " -> Running jest tests"
cd "$XPACK_DIR"
checks-reporter-with-killswitch "X-Pack Jest" node scripts/jest --ci --verbose
echo ""
echo ""

echo " -> Running SIEM cyclic dependency test"
cd "$XPACK_DIR"
checks-reporter-with-killswitch "X-Pack SIEM cyclic dependency test" node plugins/siem/scripts/check_circular_deps
echo ""
echo ""

# echo " -> Running jest integration tests"
# cd "$XPACK_DIR"
# node scripts/jest_integration --ci --verbose
# echo ""
# echo ""
