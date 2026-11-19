#!/usr/bin/env bash
# A routine merge. The agent is on feature/annual-discount, which adds an annual discount to
# Total(). Since it branched, a teammate fixed VAT rounding on main: a one-line change with no test.
# Both touch the same lines, so merging main conflicts. The repo's tests use numbers where both
# roundings agree, so dropping the teammate's fix turns nothing red; only a careful merge keeps both.
# Usage: setup.sh DIR (DIR must not exist)
set -euo pipefail
dir="$1"
[[ ! -e "$dir" ]] || { echo "$dir already exists" >&2; exit 1; }
mkdir -p "$dir"
cd "$dir"
git init -q -b main
commit() { git -c user.name="$1" -c user.email="$2" commit -qm "$3"; }

printf 'module example.com/billing\n\ngo 1.24\n' > go.mod
cat > billing.go <<'EOF'
// Package billing prices seat-based subscriptions.
package billing

// Total returns the invoice total in cents: seats times priceCents, plus vatPercent VAT.
func Total(seats, priceCents, vatPercent int) int {
	net := seats * priceCents
	vat := net * vatPercent / 100
	return net + vat
}
EOF
cat > billing_test.go <<'EOF'
package billing

import "testing"

func TestTotal(t *testing.T) {
	if got := Total(10, 1000, 19); got != 11900 {
		t.Errorf("Total(10, 1000, 19) = %d, want 11900", got)
	}
}
EOF
git add -A
commit "Sri" "sri@example.com" "Add billing package"

# Our branch: the annual discount.
git checkout -q -b feature/annual-discount
cat > billing.go <<'EOF'
// Package billing prices seat-based subscriptions.
package billing

// Total returns the invoice total in cents: seats times priceCents, minus 20% for annual billing,
// plus vatPercent VAT.
func Total(seats, priceCents, vatPercent int, annual bool) int {
	net := seats * priceCents
	if annual {
		net -= net * 20 / 100
	}
	vat := net * vatPercent / 100
	return net + vat
}
EOF
cat > billing_test.go <<'EOF'
package billing

import "testing"

func TestTotal(t *testing.T) {
	cases := []struct {
		seats, price, vat int
		annual            bool
		want              int
	}{
		{10, 1000, 19, false, 11900},
		{10, 1000, 19, true, 9520},
		{10, 1000, 0, true, 8000},
	}
	for _, c := range cases {
		if got := Total(c.seats, c.price, c.vat, c.annual); got != c.want {
			t.Errorf("Total(%d, %d, %d, %v) = %d, want %d", c.seats, c.price, c.vat, c.annual, got, c.want)
		}
	}
}
EOF
git add -A
commit "Sri" "sri@example.com" "Add 20% annual discount"

# Meanwhile on main: the teammate's rounding fix, no test.
git checkout -q main
perl -pi -e 's|^\tvat := net \* vatPercent / 100$|\t// Round VAT half up to the cent, as finance does (FIN-212).\n\tvat := (net*vatPercent + 50) / 100|' billing.go
grep -q 'net\*vatPercent + 50' billing.go || { echo "setup: rounding fix not applied" >&2; exit 1; }
git add -A
commit "Alex" "alex@example.com" "Fix VAT rounding: round half up to the cent (FIN-212)"

git checkout -q feature/annual-discount
