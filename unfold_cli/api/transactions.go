package api

import (
	"encoding/json"
	"errors"
	"math/rand"
	"strconv"
	"time"

	"github.com/rs/zerolog/log"
)

type TransactionsResponse struct {
	Meta struct {
		RequestID string    `json:"request_id"`
		Timestamp time.Time `json:"timestamp"`
		URI       string    `json:"uri"`
	} `json:"meta"`
	Data struct {
		Transactions []struct {
			UUID                         string      `json:"uuid"`
			Amount                       float64     `json:"amount"`
			CurrentBalance               float64     `json:"current_balance"`
			TxnTimestamp                 time.Time   `json:"txn_timestamp"`
			TxnDate                      time.Time   `json:"txn_date"`
			IsValidTime                  bool        `json:"is_valid_time"`
			Mode                         string      `json:"mode"`
			Type                         string      `json:"type"`
			Narration                    string      `json:"narration"`
			Category                     interface{} `json:"category"`
			CategoryID                   string      `json:"category_id"`
			CategoryIcon                 interface{} `json:"category_icon"`
			CategoryIconName             string      `json:"category_icon_name"`
			Merchant                     interface{} `json:"merchant"`
			MerchantIcon                 interface{} `json:"merchant_icon"`
			MerchantAddress              interface{} `json:"merchant_address"`
			AccountID                    string      `json:"account_id"`
			Tags                         interface{} `json:"tags"`
			Kind                         string      `json:"kind"`
			FinancialInformationProvider struct {
				UUID    string `json:"uuid"`
				Name    string `json:"name"`
				FipID   string `json:"fip_id"`
				LogoURL string `json:"logo_url"`
			} `json:"financial_information_provider"`
			Notes                interface{}   `json:"notes"`
			ExcludedFromCashFlow bool          `json:"excluded_from_cash_flow"`
			IsBookmarked         bool          `json:"is_bookmarked"`
			TransactionID        string        `json:"transaction_id"`
			Reference            string        `json:"reference"`
			ExtractedTime        interface{}   `json:"extracted_time"`
			Summary              string        `json:"summary"`
			InvalidTxnID         bool          `json:"invalid_txn_id"`
			BeforeFoldAccount    bool          `json:"before_fold_account"`
			Via                  interface{}   `json:"via"`
			AccountIn            interface{}   `json:"account_in"`
			RefundStatus         string        `json:"refund_status"`
			NotifyOnRefund       bool          `json:"notify_on_refund"`
			RefundReceivedOn     interface{}   `json:"refund_received_on"`
			Receipts             []interface{} `json:"receipts"`
			GroupIds             interface{}   `json:"group_ids"`
			ContactID            interface{}   `json:"contact_id"`
			IsF1Predicted        interface{}   `json:"is_f1_predicted"`
		} `json:"transactions"`
		Counts []struct {
			Date              string `json:"date"`
			Total             int    `json:"total"`
			BeforeFoldAccount int    `json:"before_fold_account"`
			AfterFoldAccount  int    `json:"after_fold_account"`
		} `json:"counts"`
		Total         int         `json:"total"`
		SearchSummary interface{} `json:"search_summary"`
		After         string      `json:"after"`
	} `json:"data"`
	Error interface{} `json:"error"`
}

type FilteredTransactions struct {
	UUID                 string    `json:"uuid"`
	Amount               float64   `json:"amount"`
	CurrentBalance       float64   `json:"current_balance"`
	TxnTimestamp         time.Time `json:"txn_timestamp"`
	Type                 string    `json:"type"`
	Account              string    `json:"account"`
	AccountID            string    `json:"account_id"`
	Merchant             string    `json:"merchant"`
	MerchantAddress      string    `json:"merchant_address"`
	Narration            string    `json:"narration"`
	Category             string    `json:"category"`
	CategoryID           string    `json:"category_id"`
	Subcategory          string    `json:"subcategory"`
	Tags                 string    `json:"tags"`
	Kind                 string    `json:"kind"`
	Mode                 string    `json:"mode"`
	Reference            string    `json:"reference"`
	Notes                string    `json:"notes"`
	ExcludedFromCashFlow bool      `json:"excluded_from_cash_flow"`
	IsBookmarked         bool      `json:"is_bookmarked"`
	Summary              string    `json:"summary"`
	TransactionID        string    `json:"transaction_id"`
	RefundStatus         string    `json:"refund_status"`
	RefundReceivedOn     string    `json:"refund_received_on"`
	BeforeFoldAccount    bool      `json:"before_fold_account"`
	Via                  string    `json:"via"`
	AccountIn            string    `json:"account_in"`
	ContactID            string    `json:"contact_id"`
	GroupIDs             string    `json:"group_ids"`
	F1PredictedCategory  bool      `json:"f1_predicted_category"`
	F1PredictedMerchant  bool      `json:"f1_predicted_merchant"`
}

type TransactionsReturn struct {
	Transactions []FilteredTransactions
}

func randomCursor() string {
	return strconv.Itoa(10000000 + rand.Intn(89999999))
}

func filterTransactions(raw TransactionsResponse, since time.Time) []FilteredTransactions {
	transactions := make([]FilteredTransactions, 0)

	t := raw.Data.Transactions
	for i := 0; i < len(t); i++ {

		if t[i].TxnTimestamp.Before(since) {
			break
		}

		transaction := FilteredTransactions{
			UUID:                 t[i].UUID,
			Amount:               t[i].Amount,
			Type:                 t[i].Type,
			Account:              t[i].FinancialInformationProvider.Name,
			AccountID:            t[i].AccountID,
			Merchant:             t[i].Narration,
			Narration:            t[i].Narration,
			TxnTimestamp:         t[i].TxnTimestamp,
			CurrentBalance:       t[i].CurrentBalance,
			Kind:                 t[i].Kind,
			Mode:                 t[i].Mode,
			Reference:            t[i].Reference,
			ExcludedFromCashFlow: t[i].ExcludedFromCashFlow,
			IsBookmarked:         t[i].IsBookmarked,
			Summary:              t[i].Summary,
			TransactionID:        t[i].TransactionID,
			RefundStatus:         t[i].RefundStatus,
			BeforeFoldAccount:    t[i].BeforeFoldAccount,
		}

		// Use Fold's F1 classifier if this transaction was classified
		if t[i].Merchant != nil {
			if mStr, ok := t[i].Merchant.(string); ok {
				transaction.Merchant = mStr
			} else if mObj, ok := t[i].Merchant.(map[string]interface{}); ok {
				if name, ok := mObj["name"].(string); ok {
					transaction.Merchant = name
				}
			}
		}

		// Preserve category if available
		if t[i].Category != nil {
			if cStr, ok := t[i].Category.(string); ok {
				transaction.Category = cStr
			} else if cObj, ok := t[i].Category.(map[string]interface{}); ok {
				if id, ok := cObj["id"].(string); ok {
					transaction.Category = id
				}
			}
		}

		// Preserve category_id (always a string, not interface{})
		transaction.CategoryID = t[i].CategoryID

		// Preserve subcategory (category_icon_name) — Fold's 2nd-tier classification
		transaction.Subcategory = t[i].CategoryIconName

		// Preserve merchant_address if available
		if t[i].MerchantAddress != nil {
			transaction.MerchantAddress = t[i].MerchantAddress.(string)
		}

		// Preserve via if available
		if t[i].Via != nil {
			if viaBytes, err := json.Marshal(t[i].Via); err == nil {
				transaction.Via = string(viaBytes)
			}
		}

		// Preserve account_in if available
		if t[i].AccountIn != nil {
			if aiBytes, err := json.Marshal(t[i].AccountIn); err == nil {
				transaction.AccountIn = string(aiBytes)
			}
		}

		// Preserve notes if available
		if t[i].Notes != nil {
			transaction.Notes = t[i].Notes.(string)
		}

		// Preserve tags as JSON string if available
		if t[i].Tags != nil {
			if tagsBytes, err := json.Marshal(t[i].Tags); err == nil {
				transaction.Tags = string(tagsBytes)
			}
		}

		// Preserve refund_received_on if available
		if t[i].RefundReceivedOn != nil {
			transaction.RefundReceivedOn = t[i].RefundReceivedOn.(string)
		}

		// Preserve contact_id if available
		if t[i].ContactID != nil {
			transaction.ContactID = t[i].ContactID.(string)
		}

		// Preserve group_ids as JSON string if available
		if t[i].GroupIds != nil {
			if gidBytes, err := json.Marshal(t[i].GroupIds); err == nil {
				transaction.GroupIDs = string(gidBytes)
			}
		}

		// Preserve F1 prediction flags
		if pred, ok := t[i].IsF1Predicted.(map[string]interface{}); ok {
			if v, ok := pred["category_or_subcategory"].(bool); ok {
				transaction.F1PredictedCategory = v
			}
			if v, ok := pred["merchant"].(bool); ok {
				transaction.F1PredictedMerchant = v
			}
		}

		transactions = append(transactions, transaction)
	}

	return transactions
}

func Transactions(uuid string, since time.Time, till time.Time) (TransactionsReturn, error) {

	RefreshOrFail()

	req, _ := APIRequest("GET", Url("/v3/users/"+uuid+"/transactions"), nil)
	q := req.URL.Query()
	req.URL.RawQuery = q.Encode()


	resp, err := Client.Do(req)

	if err != nil {
		return TransactionsReturn{}, err
	} else {

		log.Debug().Msgf("Transactions response status: %+v", resp.StatusCode)

		if resp.StatusCode/100 != 2 {
			return TransactionsReturn{}, errors.New(resp.Status)
		}

		data := TransactionsResponse{}
		json.NewDecoder(resp.Body).Decode(&data)

		var ret TransactionsReturn
		ret.Transactions = make([]FilteredTransactions, 0)

		if len(data.Data.Transactions) == 0 {
			return ret, nil
		}

		log.Debug().Msgf("Transactions response body: %+v", data.Data.Transactions[0].TxnTimestamp)
		ret.Transactions = append(ret.Transactions, filterTransactions(data, since)...)

		for len(data.Data.Transactions) > 0 && data.Data.Transactions[len(data.Data.Transactions)-1].TxnTimestamp.After(since) {
			log.Debug().Msg("Fetching older transactions")

			log.Debug().Msg("New cursor base64: " + data.Data.After)
			q.Set("after", data.Data.After)
			req.URL.RawQuery = q.Encode()

			resp, err := Client.Do(req)
			if err != nil {
				log.Warn().Msg("Failed to fetch older transactions")
				break
			}

			log.Debug().Msgf("Transactions response status: %+v", resp.StatusCode)

			if resp.StatusCode/100 != 2 {
				log.Warn().Msgf("Failed to fetch older transactions, status code: %+v", resp.StatusCode)
				break
			}

			json.NewDecoder(resp.Body).Decode(&data)

			if len(data.Data.Transactions) == 0 {
				break
			}

			log.Debug().Msgf("Transactions response body: %+v", data.Data.Transactions[0].TxnTimestamp)
			ret.Transactions = append(ret.Transactions, filterTransactions(data, since)...)
		}

		return ret, nil
	}
}
