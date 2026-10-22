// Generates tooling/fixtures/kubernetes-formats/expected.json: for each input,
// whether a Kubernetes 1.30 API server accepts it for a CRD schema format.
// It calls the validators the server calls: kube-openapi's strfmt.Default at
// the version Kubernetes v1.30.0 pins, behind apiextensions-apiserver's
// supportedFormats (formats outside it are dropped, so they accept anything).
// It must run on Go 1.22.2, Kubernetes v1.30.0's Go: the validators call Go's
// net/url and net/mail, whose answers change between Go releases (Go 1.23
// accepts domain literals such as a@[192.0.2.1]). go.mod pins the toolchain,
// and main refuses any other runtime.
//
// Regenerate (docs/decisions/0027-oda-canvas-probe.md):
//
//	cd tooling/fixtures/kubernetes-formats && GOTOOLCHAIN=go1.22.2 go run .
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"strings"

	"k8s.io/kube-openapi/pkg/validation/strfmt"
)

// apiextensions-apiserver pkg/apiserver/validation/formats.go at v1.30.0.
var supported = map[string]bool{
	"bsonobjectid": true, "uri": true, "email": true, "hostname": true,
	"ipv4": true, "ipv6": true, "cidr": true, "mac": true, "uuid": true,
	"uuid3": true, "uuid4": true, "uuid5": true, "isbn": true, "isbn10": true,
	"isbn13": true, "creditcard": true, "ssn": true, "hexcolor": true,
	"rgbcolor": true, "byte": true, "password": true, "date": true,
	"duration": true, "datetime": true,
}

var inputs = map[string][]string{
	"date-time": {
		"2024-09-17T00:00:00.000Z", "2024-09-17T10:20:30+02:00",
		"2024-09-17t10:20:30z", "0000-02-29T00:00:00Z", "2023-02-29T00:00:00Z",
		"2024-02-29T23:59:59Z", "2024-09-17T24:00:00Z", "2024-09-17T10:60:00Z",
		"2024-09-17T10:20:30", "2024-09-17T10:20:30.123456789-07:00",
		"2024-09-17 10:20:30Z", "definitely-not-a-date", "2024-9-17T10:20:30Z",
		"2024-09-17T10:20:30x02:00", "2024-09-17T10:20:30+0200", "",
	},
	"date": {
		"2024-02-29", "2023-02-29", "0000-02-29", "0001-01-01", "9999-12-31",
		"2024-9-17", "2024-13-01", "2024-00-10", "2024-04-31", "24-09-17", "",
	},
	"uri": {
		"https://example.org/a", "/relative/path", "urn:isbn:0451450523",
		"relative/path", "", "https://example.org/%ZZ", "https://example.org/%41",
		"https://example.org/a b", "https://exa mple.org/", "https://example.org:80/",
		"https://example.org:8x/", "https://user:pass@example.org/",
		"https://us er@example.org/", "https://[2001:db8::1]:443/",
		"https://[2001:db8::1/", "https://example.org/?q=%ZZ", "*",
		"mailto:a@example.org", "1http://example.org/", ":nothing",
		"https://example.org/a\tb", "https://ex%41mple.org/", "https://ex%C3%A9.org/",
		"https://example.org#frag", "http://example.org:/", "//example.org/path",
	},
	"email": {
		"a@example.org", "Ann <a@example.org>", "not an address", "a..b@example.org",
		"\"a b\"@example.org", ".a@example.org", "a.@example.org", "a@example..org",
		"a@", "@example.org", "a@b", "\"Ann Lee\" <a@example.org>",
		"<a@example.org>", "a@example.org (comment)", "a(b)@example.org",
		"a@[192.0.2.1]", "a+tag@example.org", "a b@example.org", "\"\"@example.org",
		"Ann Lee <a@example.org>", "a@example.org, b@example.org", "é@example.org",
		"a\\b@example.org", "\"a\\\"b\"@example.org", "Group: a@example.org;",
		"=?bogus?Q?Ann?= <a@example.org>", "a@example.org (=?bogus?Q?Ann?=)",
		"=?utf-8?Q?Ann?= <a@example.org>", "=?ISO-8859-1?q?Ann?= <a@example.org>",
		"Ann =?bogus?Q?Lee?= <a@example.org>", "=?bogus?B?QW5u?= <a@example.org>",
		"=?bogus?B?QW5u?= Lee <a@example.org>", "=?bogus?X?Ann?= <a@example.org>",
		"=?bogus?Q?A=ZZ?= <a@example.org>", "=?bogus?B?QW5?= <a@example.org>",
		"=?bogus?Q?Ann <a@example.org>", "a@example.org (Ann =?us-ascii?Q?Lee?=)",
		"a@example.org (Ann =?bogus?Q?Lee?=)", "a@example.org (=?bogus?Q?Ann?)",
		"=??Q?Ann?= <a@example.org>", "\"=?bogus?Q?Ann?=\" <a@example.org>",
	},
	"hostname": {
		"example.org", "localhost", "-bad.example", "a..b", "a-b", "ab-c",
		"a.b", "a.b1", "xn--bcher-kva.example", "bücher.example", "a_b.example",
		"example.org.", "a.b.c.example", "1.2.3.4", "-", "",
	},
	"ipv4":         {"192.0.2.1", "010.1.1.1", "2001:db8::1", "256.1.1.1", "::ffff:192.0.2.1", "1.2.3", ""},
	"ipv6":         {"2001:db8::1", "192.0.2.1", "2001:db8::1%eth0", "::ffff:192.0.2.1", "::", "2001:db8:::1"},
	"cidr":         {"192.0.2.0/24", "2001:db8::/32", "192.0.2.0/33", "192.0.2.0", "010.0.2.0/24", "192.0.2.0/024", "::ffff:192.0.2.0/120"},
	"mac":          {"00:00:5e:00:53:01", "00-00-5e-00-53-01", "0000.5e00.5301", "00:00:5e:00:53", "02:00:5e:10:00:00:00:01", "00:00:5e:00:53:0g", "00:00:5e-00:53:01"},
	"uuid":         {"123e4567-e89b-12d3-a456-426614174000", "123e4567", "123E4567E89B12D3A456426614174000"},
	"uuid4":        {"123e4567-e89b-42d3-a456-426614174000", "123e4567-e89b-12d3-a456-426614174000"},
	"uuid3":        {"a3bb189e-8bf9-3888-9912-ace4e6543002", "123e4567-e89b-42d3-a456-426614174000"},
	"uuid5":        {"886313e1-3b8a-5372-9b90-0c9aee199e5d", "123e4567-e89b-42d3-a456-426614174000"},
	"isbn":         {"0321751043", "978-0321751041", "0321751044", "0-321-75104-3", "032175104X"},
	"isbn10":       {"0321751043", "080442957X", "978-0321751041", "0321751044"},
	"isbn13":       {"978-0321751041", "9780321751041", "0321751043", "9780321751042"},
	"creditcard":   {"4111 1111 1111 1111", "4111 1111 1111 1112", "4111-1111-1111-1111", "5500000000000004", "4111"},
	"ssn":          {"123-45-6789", "123456789", "123 45 6789", "123-456-789"},
	"hexcolor":     {"#FFFFFF", "fff", "#FFFF", "#ggg"},
	"rgbcolor":     {"rgb(255, 0, 12)", "rgb(256,0,0)", "rgb(0,0,0)", "rgb( 1 , 2 , 3 )", "RGB(0,0,0)"},
	"byte":         {"aGVsbG8=", "aGVsbG8", "not base64!", "", "aGVsbG8gd29ybGQ=", "aGVs bG8="},
	"duration":     {"1h30m", "22 ns", "5 days", "-1.5h", "soon", "1x", "0", "1.5", "3 weeks ago", "10 seconds"},
	"bsonobjectid": {"507f1f77bcf86cd799439011", "507f1f77", "507f1f77bcf86cd79943901z"},
	"password":     {"anything", ""},
	"url":          {"not a url", ""},
}

func main() {
	if runtime.Version() != "go1.22.2" {
		fmt.Fprintf(os.Stderr, "run with Go 1.22.2 (GOTOOLCHAIN=go1.22.2), not %s\n", runtime.Version())
		os.Exit(1)
	}
	expected := map[string][][2]any{}
	for format, values := range inputs {
		for _, value := range values {
			valid := true
			if supported[strings.ReplaceAll(format, "-", "")] {
				valid = strfmt.Default.Validates(format, value)
			}
			expected[format] = append(expected[format], [2]any{value, valid})
		}
	}
	file, err := os.Create("expected.json")
	if err != nil {
		panic(err)
	}
	defer file.Close()
	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(expected); err != nil {
		panic(err)
	}
}
