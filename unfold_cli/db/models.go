package db

import (
	"time"
)

type Transactions struct {
	UUID                 string `gorm:"primaryKey;"`
	Amount               float64
	CurrentBalance       float64
	Timestamp            time.Time `gorm:"index:sortTimestamp,sort:desc"`
	Type                 string
	Account              string
	Merchant             string
	MerchantAddress      string
	Narration            string
	Category             string
	CategoryID           string
	Subcategory          string
	Tags                 string
	Kind                 string
	Mode                 string
	Reference            string
	Notes                string
	ExcludedFromCashFlow bool
	IsBookmarked         bool
	Summary              string
	TransactionID        string
	RefundStatus         string
	RefundReceivedOn     string
	BeforeFoldAccount    bool
	Via                  string
	AccountIn            string
	ContactID            string
	GroupIDs             string
	F1PredictedCategory  bool
	F1PredictedMerchant  bool
	AccountID            string
}
