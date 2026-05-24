package cmd

import (
	"bufio"
	"fmt"
	"os"
	"runtime"

	"github.com/rs/zerolog/log"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/wantguns/unfold/api"
)

var LoginCmd = &cobra.Command{
	Use:   "login",
	Short: "Log in to your fold account",
	Long:  `This command must be run before running any other command to authenticate the CLI`,
	Run:   loginCmdHandler,
}

func init() {
	LoginCmd.Flags().StringP("phone", "p", "", "Phone number (without +91 prefix)")
	LoginCmd.Flags().StringP("otp", "o", "", "OTP received via SMS (requires --phone)")
}

func loginCmdHandler(cmd *cobra.Command, args []string) {
	phoneFlag, _ := cmd.Flags().GetString("phone")
	otpFlag, _ := cmd.Flags().GetString("otp")

	var phoneNum string
	if phoneFlag != "" {
		phoneNum = phoneFlag
	} else {
		fmt.Print("Enter the phone number associated with your fold account: ")
		phone := bufio.NewScanner(os.Stdin)
		phone.Scan()
		phoneNum = phone.Text()
	}

	// If --otp is not provided, request OTP first
	if otpFlag == "" {
		err := api.Login("+91" + phoneNum)
		if err != nil {
			log.Error().Err(err).Msg("Login response: ")
			runtime.Goexit()
		}

		fmt.Print("Login request successful, enter OTP: ")
		otp := bufio.NewScanner(os.Stdin)
		otp.Scan()
		otpFlag = otp.Text()
	}

	access, refresh, err := api.VerifyOtp("+91"+phoneNum, otpFlag)
	if err != nil {
		log.Error().Err(err).Msg("Verify otp response: ")
		runtime.Goexit()
	}

	viper.Set("token.access", access)
	viper.Set("token.refresh", refresh)

	log.Debug().Msg("Fetching user info")
	user_uuid, err := api.User()
	if err != nil {
		log.Error().Err(err).Msg("Refresh response: ")
		runtime.Goexit()
	}

	viper.Set("fold_user.uuid", user_uuid)

	fmt.Println("Login successful !")
}
