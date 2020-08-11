(ns glam.client.ui.material-ui-icon
  "Generation script:
def title2kebab(s):
    return \"\".join([
        '-' + c.lower() if c.isupper() and i != 0 else c.lower()
        for i, c in enumerate(s)
    ])
print(
'''(ns glam.client.ui.material-ui-icon
  (:require ''', end=\"\")
print(f'[\"@material-ui/icons/{xs[0]}\" :default {xs[0]}]')
for x in xs[1:-1]:
    print(f'            [\"@material-ui/icons/{x}\" :default {x}]')
print(f'            [\"@material-ui/icons/{xs[-1]}\" :default {xs[-1]}]))')
print()
for x in xs:
    print(f\"(def {title2kebab(x)} (interop/react-factory {x}))\")
  "
  (:refer-clojure :exclude [comment compare filter list loop map print remove repeat shuffle sort update])
  (:require [com.fulcrologic.fulcro.algorithms.react-interop :as interop]
            ["@material-ui/icons/AccessAlarm" :default AccessAlarm]
            ["@material-ui/icons/AccessAlarmOutlined" :default AccessAlarmOutlined]
            ["@material-ui/icons/AccessAlarmRounded" :default AccessAlarmRounded]
            ["@material-ui/icons/AccessAlarms" :default AccessAlarms]
            ["@material-ui/icons/AccessAlarmSharp" :default AccessAlarmSharp]
            ["@material-ui/icons/AccessAlarmsOutlined" :default AccessAlarmsOutlined]
            ["@material-ui/icons/AccessAlarmsRounded" :default AccessAlarmsRounded]
            ["@material-ui/icons/AccessAlarmsSharp" :default AccessAlarmsSharp]
            ["@material-ui/icons/AccessAlarmsTwoTone" :default AccessAlarmsTwoTone]
            ["@material-ui/icons/AccessAlarmTwoTone" :default AccessAlarmTwoTone]
            ["@material-ui/icons/Accessibility" :default Accessibility]
            ["@material-ui/icons/AccessibilityNew" :default AccessibilityNew]
            ["@material-ui/icons/AccessibilityNewOutlined" :default AccessibilityNewOutlined]
            ["@material-ui/icons/AccessibilityNewRounded" :default AccessibilityNewRounded]
            ["@material-ui/icons/AccessibilityNewSharp" :default AccessibilityNewSharp]
            ["@material-ui/icons/AccessibilityNewTwoTone" :default AccessibilityNewTwoTone]
            ["@material-ui/icons/AccessibilityOutlined" :default AccessibilityOutlined]
            ["@material-ui/icons/AccessibilityRounded" :default AccessibilityRounded]
            ["@material-ui/icons/AccessibilitySharp" :default AccessibilitySharp]
            ["@material-ui/icons/AccessibilityTwoTone" :default AccessibilityTwoTone]
            ["@material-ui/icons/Accessible" :default Accessible]
            ["@material-ui/icons/AccessibleForward" :default AccessibleForward]
            ["@material-ui/icons/AccessibleForwardOutlined" :default AccessibleForwardOutlined]
            ["@material-ui/icons/AccessibleForwardRounded" :default AccessibleForwardRounded]
            ["@material-ui/icons/AccessibleForwardSharp" :default AccessibleForwardSharp]
            ["@material-ui/icons/AccessibleForwardTwoTone" :default AccessibleForwardTwoTone]
            ["@material-ui/icons/AccessibleOutlined" :default AccessibleOutlined]
            ["@material-ui/icons/AccessibleRounded" :default AccessibleRounded]
            ["@material-ui/icons/AccessibleSharp" :default AccessibleSharp]
            ["@material-ui/icons/AccessibleTwoTone" :default AccessibleTwoTone]
            ["@material-ui/icons/AccessTime" :default AccessTime]
            ["@material-ui/icons/AccessTimeOutlined" :default AccessTimeOutlined]
            ["@material-ui/icons/AccessTimeRounded" :default AccessTimeRounded]
            ["@material-ui/icons/AccessTimeSharp" :default AccessTimeSharp]
            ["@material-ui/icons/AccessTimeTwoTone" :default AccessTimeTwoTone]
            ["@material-ui/icons/AccountBalance" :default AccountBalance]
            ["@material-ui/icons/AccountBalanceOutlined" :default AccountBalanceOutlined]
            ["@material-ui/icons/AccountBalanceRounded" :default AccountBalanceRounded]
            ["@material-ui/icons/AccountBalanceSharp" :default AccountBalanceSharp]
            ["@material-ui/icons/AccountBalanceTwoTone" :default AccountBalanceTwoTone]
            ["@material-ui/icons/AccountBalanceWallet" :default AccountBalanceWallet]
            ["@material-ui/icons/AccountBalanceWalletOutlined" :default AccountBalanceWalletOutlined]
            ["@material-ui/icons/AccountBalanceWalletRounded" :default AccountBalanceWalletRounded]
            ["@material-ui/icons/AccountBalanceWalletSharp" :default AccountBalanceWalletSharp]
            ["@material-ui/icons/AccountBalanceWalletTwoTone" :default AccountBalanceWalletTwoTone]
            ["@material-ui/icons/AccountBox" :default AccountBox]
            ["@material-ui/icons/AccountBoxOutlined" :default AccountBoxOutlined]
            ["@material-ui/icons/AccountBoxRounded" :default AccountBoxRounded]
            ["@material-ui/icons/AccountBoxSharp" :default AccountBoxSharp]
            ["@material-ui/icons/AccountBoxTwoTone" :default AccountBoxTwoTone]
            ["@material-ui/icons/AccountCircle" :default AccountCircle]
            ["@material-ui/icons/AccountCircleOutlined" :default AccountCircleOutlined]
            ["@material-ui/icons/AccountCircleRounded" :default AccountCircleRounded]
            ["@material-ui/icons/AccountCircleSharp" :default AccountCircleSharp]
            ["@material-ui/icons/AccountCircleTwoTone" :default AccountCircleTwoTone]
            ["@material-ui/icons/AccountTree" :default AccountTree]
            ["@material-ui/icons/AccountTreeOutlined" :default AccountTreeOutlined]
            ["@material-ui/icons/AccountTreeRounded" :default AccountTreeRounded]
            ["@material-ui/icons/AccountTreeSharp" :default AccountTreeSharp]
            ["@material-ui/icons/AccountTreeTwoTone" :default AccountTreeTwoTone]
            ["@material-ui/icons/AcUnit" :default AcUnit]
            ["@material-ui/icons/AcUnitOutlined" :default AcUnitOutlined]
            ["@material-ui/icons/AcUnitRounded" :default AcUnitRounded]
            ["@material-ui/icons/AcUnitSharp" :default AcUnitSharp]
            ["@material-ui/icons/AcUnitTwoTone" :default AcUnitTwoTone]
            ["@material-ui/icons/Adb" :default Adb]
            ["@material-ui/icons/AdbOutlined" :default AdbOutlined]
            ["@material-ui/icons/AdbRounded" :default AdbRounded]
            ["@material-ui/icons/AdbSharp" :default AdbSharp]
            ["@material-ui/icons/AdbTwoTone" :default AdbTwoTone]
            ["@material-ui/icons/Add" :default Add]
            ["@material-ui/icons/AddAlarm" :default AddAlarm]
            ["@material-ui/icons/AddAlarmOutlined" :default AddAlarmOutlined]
            ["@material-ui/icons/AddAlarmRounded" :default AddAlarmRounded]
            ["@material-ui/icons/AddAlarmSharp" :default AddAlarmSharp]
            ["@material-ui/icons/AddAlarmTwoTone" :default AddAlarmTwoTone]
            ["@material-ui/icons/AddAlert" :default AddAlert]
            ["@material-ui/icons/AddAlertOutlined" :default AddAlertOutlined]
            ["@material-ui/icons/AddAlertRounded" :default AddAlertRounded]
            ["@material-ui/icons/AddAlertSharp" :default AddAlertSharp]
            ["@material-ui/icons/AddAlertTwoTone" :default AddAlertTwoTone]
            ["@material-ui/icons/AddAPhoto" :default AddAPhoto]
            ["@material-ui/icons/AddAPhotoOutlined" :default AddAPhotoOutlined]
            ["@material-ui/icons/AddAPhotoRounded" :default AddAPhotoRounded]
            ["@material-ui/icons/AddAPhotoSharp" :default AddAPhotoSharp]
            ["@material-ui/icons/AddAPhotoTwoTone" :default AddAPhotoTwoTone]
            ["@material-ui/icons/AddBox" :default AddBox]
            ["@material-ui/icons/AddBoxOutlined" :default AddBoxOutlined]
            ["@material-ui/icons/AddBoxRounded" :default AddBoxRounded]
            ["@material-ui/icons/AddBoxSharp" :default AddBoxSharp]
            ["@material-ui/icons/AddBoxTwoTone" :default AddBoxTwoTone]
            ["@material-ui/icons/AddCircle" :default AddCircle]
            ["@material-ui/icons/AddCircleOutline" :default AddCircleOutline]
            ["@material-ui/icons/AddCircleOutlined" :default AddCircleOutlined]
            ["@material-ui/icons/AddCircleOutlineOutlined" :default AddCircleOutlineOutlined]
            ["@material-ui/icons/AddCircleOutlineRounded" :default AddCircleOutlineRounded]
            ["@material-ui/icons/AddCircleOutlineSharp" :default AddCircleOutlineSharp]
            ["@material-ui/icons/AddCircleOutlineTwoTone" :default AddCircleOutlineTwoTone]
            ["@material-ui/icons/AddCircleRounded" :default AddCircleRounded]
            ["@material-ui/icons/AddCircleSharp" :default AddCircleSharp]
            ["@material-ui/icons/AddCircleTwoTone" :default AddCircleTwoTone]
            ["@material-ui/icons/AddComment" :default AddComment]
            ["@material-ui/icons/AddCommentOutlined" :default AddCommentOutlined]
            ["@material-ui/icons/AddCommentRounded" :default AddCommentRounded]
            ["@material-ui/icons/AddCommentSharp" :default AddCommentSharp]
            ["@material-ui/icons/AddCommentTwoTone" :default AddCommentTwoTone]
            ["@material-ui/icons/AddIcCall" :default AddIcCall]
            ["@material-ui/icons/AddIcCallOutlined" :default AddIcCallOutlined]
            ["@material-ui/icons/AddIcCallRounded" :default AddIcCallRounded]
            ["@material-ui/icons/AddIcCallSharp" :default AddIcCallSharp]
            ["@material-ui/icons/AddIcCallTwoTone" :default AddIcCallTwoTone]
            ["@material-ui/icons/AddLocation" :default AddLocation]
            ["@material-ui/icons/AddLocationOutlined" :default AddLocationOutlined]
            ["@material-ui/icons/AddLocationRounded" :default AddLocationRounded]
            ["@material-ui/icons/AddLocationSharp" :default AddLocationSharp]
            ["@material-ui/icons/AddLocationTwoTone" :default AddLocationTwoTone]
            ["@material-ui/icons/AddOutlined" :default AddOutlined]
            ["@material-ui/icons/AddPhotoAlternate" :default AddPhotoAlternate]
            ["@material-ui/icons/AddPhotoAlternateOutlined" :default AddPhotoAlternateOutlined]
            ["@material-ui/icons/AddPhotoAlternateRounded" :default AddPhotoAlternateRounded]
            ["@material-ui/icons/AddPhotoAlternateSharp" :default AddPhotoAlternateSharp]
            ["@material-ui/icons/AddPhotoAlternateTwoTone" :default AddPhotoAlternateTwoTone]
            ["@material-ui/icons/AddRounded" :default AddRounded]
            ["@material-ui/icons/AddSharp" :default AddSharp]
            ["@material-ui/icons/AddShoppingCart" :default AddShoppingCart]
            ["@material-ui/icons/AddShoppingCartOutlined" :default AddShoppingCartOutlined]
            ["@material-ui/icons/AddShoppingCartRounded" :default AddShoppingCartRounded]
            ["@material-ui/icons/AddShoppingCartSharp" :default AddShoppingCartSharp]
            ["@material-ui/icons/AddShoppingCartTwoTone" :default AddShoppingCartTwoTone]
            ["@material-ui/icons/AddToHomeScreen" :default AddToHomeScreen]
            ["@material-ui/icons/AddToHomeScreenOutlined" :default AddToHomeScreenOutlined]
            ["@material-ui/icons/AddToHomeScreenRounded" :default AddToHomeScreenRounded]
            ["@material-ui/icons/AddToHomeScreenSharp" :default AddToHomeScreenSharp]
            ["@material-ui/icons/AddToHomeScreenTwoTone" :default AddToHomeScreenTwoTone]
            ["@material-ui/icons/AddToPhotos" :default AddToPhotos]
            ["@material-ui/icons/AddToPhotosOutlined" :default AddToPhotosOutlined]
            ["@material-ui/icons/AddToPhotosRounded" :default AddToPhotosRounded]
            ["@material-ui/icons/AddToPhotosSharp" :default AddToPhotosSharp]
            ["@material-ui/icons/AddToPhotosTwoTone" :default AddToPhotosTwoTone]
            ["@material-ui/icons/AddToQueue" :default AddToQueue]
            ["@material-ui/icons/AddToQueueOutlined" :default AddToQueueOutlined]
            ["@material-ui/icons/AddToQueueRounded" :default AddToQueueRounded]
            ["@material-ui/icons/AddToQueueSharp" :default AddToQueueSharp]
            ["@material-ui/icons/AddToQueueTwoTone" :default AddToQueueTwoTone]
            ["@material-ui/icons/AddTwoTone" :default AddTwoTone]
            ["@material-ui/icons/Adjust" :default Adjust]
            ["@material-ui/icons/AdjustOutlined" :default AdjustOutlined]
            ["@material-ui/icons/AdjustRounded" :default AdjustRounded]
            ["@material-ui/icons/AdjustSharp" :default AdjustSharp]
            ["@material-ui/icons/AdjustTwoTone" :default AdjustTwoTone]
            ["@material-ui/icons/AirlineSeatFlat" :default AirlineSeatFlat]
            ["@material-ui/icons/AirlineSeatFlatAngled" :default AirlineSeatFlatAngled]
            ["@material-ui/icons/AirlineSeatFlatAngledOutlined" :default AirlineSeatFlatAngledOutlined]
            ["@material-ui/icons/AirlineSeatFlatAngledRounded" :default AirlineSeatFlatAngledRounded]
            ["@material-ui/icons/AirlineSeatFlatAngledSharp" :default AirlineSeatFlatAngledSharp]
            ["@material-ui/icons/AirlineSeatFlatAngledTwoTone" :default AirlineSeatFlatAngledTwoTone]
            ["@material-ui/icons/AirlineSeatFlatOutlined" :default AirlineSeatFlatOutlined]
            ["@material-ui/icons/AirlineSeatFlatRounded" :default AirlineSeatFlatRounded]
            ["@material-ui/icons/AirlineSeatFlatSharp" :default AirlineSeatFlatSharp]
            ["@material-ui/icons/AirlineSeatFlatTwoTone" :default AirlineSeatFlatTwoTone]
            ["@material-ui/icons/AirlineSeatIndividualSuite" :default AirlineSeatIndividualSuite]
            ["@material-ui/icons/AirlineSeatIndividualSuiteOutlined" :default AirlineSeatIndividualSuiteOutlined]
            ["@material-ui/icons/AirlineSeatIndividualSuiteRounded" :default AirlineSeatIndividualSuiteRounded]
            ["@material-ui/icons/AirlineSeatIndividualSuiteSharp" :default AirlineSeatIndividualSuiteSharp]
            ["@material-ui/icons/AirlineSeatIndividualSuiteTwoTone" :default AirlineSeatIndividualSuiteTwoTone]
            ["@material-ui/icons/AirlineSeatLegroomExtra" :default AirlineSeatLegroomExtra]
            ["@material-ui/icons/AirlineSeatLegroomExtraOutlined" :default AirlineSeatLegroomExtraOutlined]
            ["@material-ui/icons/AirlineSeatLegroomExtraRounded" :default AirlineSeatLegroomExtraRounded]
            ["@material-ui/icons/AirlineSeatLegroomExtraSharp" :default AirlineSeatLegroomExtraSharp]
            ["@material-ui/icons/AirlineSeatLegroomExtraTwoTone" :default AirlineSeatLegroomExtraTwoTone]
            ["@material-ui/icons/AirlineSeatLegroomNormal" :default AirlineSeatLegroomNormal]
            ["@material-ui/icons/AirlineSeatLegroomNormalOutlined" :default AirlineSeatLegroomNormalOutlined]
            ["@material-ui/icons/AirlineSeatLegroomNormalRounded" :default AirlineSeatLegroomNormalRounded]
            ["@material-ui/icons/AirlineSeatLegroomNormalSharp" :default AirlineSeatLegroomNormalSharp]
            ["@material-ui/icons/AirlineSeatLegroomNormalTwoTone" :default AirlineSeatLegroomNormalTwoTone]
            ["@material-ui/icons/AirlineSeatLegroomReduced" :default AirlineSeatLegroomReduced]
            ["@material-ui/icons/AirlineSeatLegroomReducedOutlined" :default AirlineSeatLegroomReducedOutlined]
            ["@material-ui/icons/AirlineSeatLegroomReducedRounded" :default AirlineSeatLegroomReducedRounded]
            ["@material-ui/icons/AirlineSeatLegroomReducedSharp" :default AirlineSeatLegroomReducedSharp]
            ["@material-ui/icons/AirlineSeatLegroomReducedTwoTone" :default AirlineSeatLegroomReducedTwoTone]
            ["@material-ui/icons/AirlineSeatReclineExtra" :default AirlineSeatReclineExtra]
            ["@material-ui/icons/AirlineSeatReclineExtraOutlined" :default AirlineSeatReclineExtraOutlined]
            ["@material-ui/icons/AirlineSeatReclineExtraRounded" :default AirlineSeatReclineExtraRounded]
            ["@material-ui/icons/AirlineSeatReclineExtraSharp" :default AirlineSeatReclineExtraSharp]
            ["@material-ui/icons/AirlineSeatReclineExtraTwoTone" :default AirlineSeatReclineExtraTwoTone]
            ["@material-ui/icons/AirlineSeatReclineNormal" :default AirlineSeatReclineNormal]
            ["@material-ui/icons/AirlineSeatReclineNormalOutlined" :default AirlineSeatReclineNormalOutlined]
            ["@material-ui/icons/AirlineSeatReclineNormalRounded" :default AirlineSeatReclineNormalRounded]
            ["@material-ui/icons/AirlineSeatReclineNormalSharp" :default AirlineSeatReclineNormalSharp]
            ["@material-ui/icons/AirlineSeatReclineNormalTwoTone" :default AirlineSeatReclineNormalTwoTone]
            ["@material-ui/icons/AirplanemodeActive" :default AirplanemodeActive]
            ["@material-ui/icons/AirplanemodeActiveOutlined" :default AirplanemodeActiveOutlined]
            ["@material-ui/icons/AirplanemodeActiveRounded" :default AirplanemodeActiveRounded]
            ["@material-ui/icons/AirplanemodeActiveSharp" :default AirplanemodeActiveSharp]
            ["@material-ui/icons/AirplanemodeActiveTwoTone" :default AirplanemodeActiveTwoTone]
            ["@material-ui/icons/AirplanemodeInactive" :default AirplanemodeInactive]
            ["@material-ui/icons/AirplanemodeInactiveOutlined" :default AirplanemodeInactiveOutlined]
            ["@material-ui/icons/AirplanemodeInactiveRounded" :default AirplanemodeInactiveRounded]
            ["@material-ui/icons/AirplanemodeInactiveSharp" :default AirplanemodeInactiveSharp]
            ["@material-ui/icons/AirplanemodeInactiveTwoTone" :default AirplanemodeInactiveTwoTone]
            ["@material-ui/icons/Airplay" :default Airplay]
            ["@material-ui/icons/AirplayOutlined" :default AirplayOutlined]
            ["@material-ui/icons/AirplayRounded" :default AirplayRounded]
            ["@material-ui/icons/AirplaySharp" :default AirplaySharp]
            ["@material-ui/icons/AirplayTwoTone" :default AirplayTwoTone]
            ["@material-ui/icons/AirportShuttle" :default AirportShuttle]
            ["@material-ui/icons/AirportShuttleOutlined" :default AirportShuttleOutlined]
            ["@material-ui/icons/AirportShuttleRounded" :default AirportShuttleRounded]
            ["@material-ui/icons/AirportShuttleSharp" :default AirportShuttleSharp]
            ["@material-ui/icons/AirportShuttleTwoTone" :default AirportShuttleTwoTone]
            ["@material-ui/icons/Alarm" :default Alarm]
            ["@material-ui/icons/AlarmAdd" :default AlarmAdd]
            ["@material-ui/icons/AlarmAddOutlined" :default AlarmAddOutlined]
            ["@material-ui/icons/AlarmAddRounded" :default AlarmAddRounded]
            ["@material-ui/icons/AlarmAddSharp" :default AlarmAddSharp]
            ["@material-ui/icons/AlarmAddTwoTone" :default AlarmAddTwoTone]
            ["@material-ui/icons/AlarmOff" :default AlarmOff]
            ["@material-ui/icons/AlarmOffOutlined" :default AlarmOffOutlined]
            ["@material-ui/icons/AlarmOffRounded" :default AlarmOffRounded]
            ["@material-ui/icons/AlarmOffSharp" :default AlarmOffSharp]
            ["@material-ui/icons/AlarmOffTwoTone" :default AlarmOffTwoTone]
            ["@material-ui/icons/AlarmOn" :default AlarmOn]
            ["@material-ui/icons/AlarmOnOutlined" :default AlarmOnOutlined]
            ["@material-ui/icons/AlarmOnRounded" :default AlarmOnRounded]
            ["@material-ui/icons/AlarmOnSharp" :default AlarmOnSharp]
            ["@material-ui/icons/AlarmOnTwoTone" :default AlarmOnTwoTone]
            ["@material-ui/icons/AlarmOutlined" :default AlarmOutlined]
            ["@material-ui/icons/AlarmRounded" :default AlarmRounded]
            ["@material-ui/icons/AlarmSharp" :default AlarmSharp]
            ["@material-ui/icons/AlarmTwoTone" :default AlarmTwoTone]
            ["@material-ui/icons/Album" :default Album]
            ["@material-ui/icons/AlbumOutlined" :default AlbumOutlined]
            ["@material-ui/icons/AlbumRounded" :default AlbumRounded]
            ["@material-ui/icons/AlbumSharp" :default AlbumSharp]
            ["@material-ui/icons/AlbumTwoTone" :default AlbumTwoTone]
            ["@material-ui/icons/AllInbox" :default AllInbox]
            ["@material-ui/icons/AllInboxOutlined" :default AllInboxOutlined]
            ["@material-ui/icons/AllInboxRounded" :default AllInboxRounded]
            ["@material-ui/icons/AllInboxSharp" :default AllInboxSharp]
            ["@material-ui/icons/AllInboxTwoTone" :default AllInboxTwoTone]
            ["@material-ui/icons/AllInclusive" :default AllInclusive]
            ["@material-ui/icons/AllInclusiveOutlined" :default AllInclusiveOutlined]
            ["@material-ui/icons/AllInclusiveRounded" :default AllInclusiveRounded]
            ["@material-ui/icons/AllInclusiveSharp" :default AllInclusiveSharp]
            ["@material-ui/icons/AllInclusiveTwoTone" :default AllInclusiveTwoTone]
            ["@material-ui/icons/AllOut" :default AllOut]
            ["@material-ui/icons/AllOutOutlined" :default AllOutOutlined]
            ["@material-ui/icons/AllOutRounded" :default AllOutRounded]
            ["@material-ui/icons/AllOutSharp" :default AllOutSharp]
            ["@material-ui/icons/AllOutTwoTone" :default AllOutTwoTone]
            ["@material-ui/icons/AlternateEmail" :default AlternateEmail]
            ["@material-ui/icons/AlternateEmailOutlined" :default AlternateEmailOutlined]
            ["@material-ui/icons/AlternateEmailRounded" :default AlternateEmailRounded]
            ["@material-ui/icons/AlternateEmailSharp" :default AlternateEmailSharp]
            ["@material-ui/icons/AlternateEmailTwoTone" :default AlternateEmailTwoTone]
            ["@material-ui/icons/AmpStories" :default AmpStories]
            ["@material-ui/icons/AmpStoriesOutlined" :default AmpStoriesOutlined]
            ["@material-ui/icons/AmpStoriesRounded" :default AmpStoriesRounded]
            ["@material-ui/icons/AmpStoriesSharp" :default AmpStoriesSharp]
            ["@material-ui/icons/AmpStoriesTwoTone" :default AmpStoriesTwoTone]
            ["@material-ui/icons/Android" :default Android]
            ["@material-ui/icons/AndroidOutlined" :default AndroidOutlined]
            ["@material-ui/icons/AndroidRounded" :default AndroidRounded]
            ["@material-ui/icons/AndroidSharp" :default AndroidSharp]
            ["@material-ui/icons/AndroidTwoTone" :default AndroidTwoTone]
            ["@material-ui/icons/Announcement" :default Announcement]
            ["@material-ui/icons/AnnouncementOutlined" :default AnnouncementOutlined]
            ["@material-ui/icons/AnnouncementRounded" :default AnnouncementRounded]
            ["@material-ui/icons/AnnouncementSharp" :default AnnouncementSharp]
            ["@material-ui/icons/AnnouncementTwoTone" :default AnnouncementTwoTone]
            ["@material-ui/icons/Apartment" :default Apartment]
            ["@material-ui/icons/ApartmentOutlined" :default ApartmentOutlined]
            ["@material-ui/icons/ApartmentRounded" :default ApartmentRounded]
            ["@material-ui/icons/ApartmentSharp" :default ApartmentSharp]
            ["@material-ui/icons/ApartmentTwoTone" :default ApartmentTwoTone]
            ["@material-ui/icons/Apple" :default Apple]
            ["@material-ui/icons/Apps" :default Apps]
            ["@material-ui/icons/AppsOutlined" :default AppsOutlined]
            ["@material-ui/icons/AppsRounded" :default AppsRounded]
            ["@material-ui/icons/AppsSharp" :default AppsSharp]
            ["@material-ui/icons/AppsTwoTone" :default AppsTwoTone]
            ["@material-ui/icons/Archive" :default Archive]
            ["@material-ui/icons/ArchiveOutlined" :default ArchiveOutlined]
            ["@material-ui/icons/ArchiveRounded" :default ArchiveRounded]
            ["@material-ui/icons/ArchiveSharp" :default ArchiveSharp]
            ["@material-ui/icons/ArchiveTwoTone" :default ArchiveTwoTone]
            ["@material-ui/icons/ArrowBack" :default ArrowBack]
            ["@material-ui/icons/ArrowBackIos" :default ArrowBackIos]
            ["@material-ui/icons/ArrowBackIosOutlined" :default ArrowBackIosOutlined]
            ["@material-ui/icons/ArrowBackIosRounded" :default ArrowBackIosRounded]
            ["@material-ui/icons/ArrowBackIosSharp" :default ArrowBackIosSharp]
            ["@material-ui/icons/ArrowBackIosTwoTone" :default ArrowBackIosTwoTone]
            ["@material-ui/icons/ArrowBackOutlined" :default ArrowBackOutlined]
            ["@material-ui/icons/ArrowBackRounded" :default ArrowBackRounded]
            ["@material-ui/icons/ArrowBackSharp" :default ArrowBackSharp]
            ["@material-ui/icons/ArrowBackTwoTone" :default ArrowBackTwoTone]
            ["@material-ui/icons/ArrowDownward" :default ArrowDownward]
            ["@material-ui/icons/ArrowDownwardOutlined" :default ArrowDownwardOutlined]
            ["@material-ui/icons/ArrowDownwardRounded" :default ArrowDownwardRounded]
            ["@material-ui/icons/ArrowDownwardSharp" :default ArrowDownwardSharp]
            ["@material-ui/icons/ArrowDownwardTwoTone" :default ArrowDownwardTwoTone]
            ["@material-ui/icons/ArrowDropDown" :default ArrowDropDown]
            ["@material-ui/icons/ArrowDropDownCircle" :default ArrowDropDownCircle]
            ["@material-ui/icons/ArrowDropDownCircleOutlined" :default ArrowDropDownCircleOutlined]
            ["@material-ui/icons/ArrowDropDownCircleRounded" :default ArrowDropDownCircleRounded]
            ["@material-ui/icons/ArrowDropDownCircleSharp" :default ArrowDropDownCircleSharp]
            ["@material-ui/icons/ArrowDropDownCircleTwoTone" :default ArrowDropDownCircleTwoTone]
            ["@material-ui/icons/ArrowDropDownOutlined" :default ArrowDropDownOutlined]
            ["@material-ui/icons/ArrowDropDownRounded" :default ArrowDropDownRounded]
            ["@material-ui/icons/ArrowDropDownSharp" :default ArrowDropDownSharp]
            ["@material-ui/icons/ArrowDropDownTwoTone" :default ArrowDropDownTwoTone]
            ["@material-ui/icons/ArrowDropUp" :default ArrowDropUp]
            ["@material-ui/icons/ArrowDropUpOutlined" :default ArrowDropUpOutlined]
            ["@material-ui/icons/ArrowDropUpRounded" :default ArrowDropUpRounded]
            ["@material-ui/icons/ArrowDropUpSharp" :default ArrowDropUpSharp]
            ["@material-ui/icons/ArrowDropUpTwoTone" :default ArrowDropUpTwoTone]
            ["@material-ui/icons/ArrowForward" :default ArrowForward]
            ["@material-ui/icons/ArrowForwardIos" :default ArrowForwardIos]
            ["@material-ui/icons/ArrowForwardIosOutlined" :default ArrowForwardIosOutlined]
            ["@material-ui/icons/ArrowForwardIosRounded" :default ArrowForwardIosRounded]
            ["@material-ui/icons/ArrowForwardIosSharp" :default ArrowForwardIosSharp]
            ["@material-ui/icons/ArrowForwardIosTwoTone" :default ArrowForwardIosTwoTone]
            ["@material-ui/icons/ArrowForwardOutlined" :default ArrowForwardOutlined]
            ["@material-ui/icons/ArrowForwardRounded" :default ArrowForwardRounded]
            ["@material-ui/icons/ArrowForwardSharp" :default ArrowForwardSharp]
            ["@material-ui/icons/ArrowForwardTwoTone" :default ArrowForwardTwoTone]
            ["@material-ui/icons/ArrowLeft" :default ArrowLeft]
            ["@material-ui/icons/ArrowLeftOutlined" :default ArrowLeftOutlined]
            ["@material-ui/icons/ArrowLeftRounded" :default ArrowLeftRounded]
            ["@material-ui/icons/ArrowLeftSharp" :default ArrowLeftSharp]
            ["@material-ui/icons/ArrowLeftTwoTone" :default ArrowLeftTwoTone]
            ["@material-ui/icons/ArrowRight" :default ArrowRight]
            ["@material-ui/icons/ArrowRightAlt" :default ArrowRightAlt]
            ["@material-ui/icons/ArrowRightAltOutlined" :default ArrowRightAltOutlined]
            ["@material-ui/icons/ArrowRightAltRounded" :default ArrowRightAltRounded]
            ["@material-ui/icons/ArrowRightAltSharp" :default ArrowRightAltSharp]
            ["@material-ui/icons/ArrowRightAltTwoTone" :default ArrowRightAltTwoTone]
            ["@material-ui/icons/ArrowRightOutlined" :default ArrowRightOutlined]
            ["@material-ui/icons/ArrowRightRounded" :default ArrowRightRounded]
            ["@material-ui/icons/ArrowRightSharp" :default ArrowRightSharp]
            ["@material-ui/icons/ArrowRightTwoTone" :default ArrowRightTwoTone]
            ["@material-ui/icons/ArrowUpward" :default ArrowUpward]
            ["@material-ui/icons/ArrowUpwardOutlined" :default ArrowUpwardOutlined]
            ["@material-ui/icons/ArrowUpwardRounded" :default ArrowUpwardRounded]
            ["@material-ui/icons/ArrowUpwardSharp" :default ArrowUpwardSharp]
            ["@material-ui/icons/ArrowUpwardTwoTone" :default ArrowUpwardTwoTone]
            ["@material-ui/icons/ArtTrack" :default ArtTrack]
            ["@material-ui/icons/ArtTrackOutlined" :default ArtTrackOutlined]
            ["@material-ui/icons/ArtTrackRounded" :default ArtTrackRounded]
            ["@material-ui/icons/ArtTrackSharp" :default ArtTrackSharp]
            ["@material-ui/icons/ArtTrackTwoTone" :default ArtTrackTwoTone]
            ["@material-ui/icons/AspectRatio" :default AspectRatio]
            ["@material-ui/icons/AspectRatioOutlined" :default AspectRatioOutlined]
            ["@material-ui/icons/AspectRatioRounded" :default AspectRatioRounded]
            ["@material-ui/icons/AspectRatioSharp" :default AspectRatioSharp]
            ["@material-ui/icons/AspectRatioTwoTone" :default AspectRatioTwoTone]
            ["@material-ui/icons/Assessment" :default Assessment]
            ["@material-ui/icons/AssessmentOutlined" :default AssessmentOutlined]
            ["@material-ui/icons/AssessmentRounded" :default AssessmentRounded]
            ["@material-ui/icons/AssessmentSharp" :default AssessmentSharp]
            ["@material-ui/icons/AssessmentTwoTone" :default AssessmentTwoTone]
            ["@material-ui/icons/Assignment" :default Assignment]
            ["@material-ui/icons/AssignmentInd" :default AssignmentInd]
            ["@material-ui/icons/AssignmentIndOutlined" :default AssignmentIndOutlined]
            ["@material-ui/icons/AssignmentIndRounded" :default AssignmentIndRounded]
            ["@material-ui/icons/AssignmentIndSharp" :default AssignmentIndSharp]
            ["@material-ui/icons/AssignmentIndTwoTone" :default AssignmentIndTwoTone]
            ["@material-ui/icons/AssignmentLate" :default AssignmentLate]
            ["@material-ui/icons/AssignmentLateOutlined" :default AssignmentLateOutlined]
            ["@material-ui/icons/AssignmentLateRounded" :default AssignmentLateRounded]
            ["@material-ui/icons/AssignmentLateSharp" :default AssignmentLateSharp]
            ["@material-ui/icons/AssignmentLateTwoTone" :default AssignmentLateTwoTone]
            ["@material-ui/icons/AssignmentOutlined" :default AssignmentOutlined]
            ["@material-ui/icons/AssignmentReturn" :default AssignmentReturn]
            ["@material-ui/icons/AssignmentReturned" :default AssignmentReturned]
            ["@material-ui/icons/AssignmentReturnedOutlined" :default AssignmentReturnedOutlined]
            ["@material-ui/icons/AssignmentReturnedRounded" :default AssignmentReturnedRounded]
            ["@material-ui/icons/AssignmentReturnedSharp" :default AssignmentReturnedSharp]
            ["@material-ui/icons/AssignmentReturnedTwoTone" :default AssignmentReturnedTwoTone]
            ["@material-ui/icons/AssignmentReturnOutlined" :default AssignmentReturnOutlined]
            ["@material-ui/icons/AssignmentReturnRounded" :default AssignmentReturnRounded]
            ["@material-ui/icons/AssignmentReturnSharp" :default AssignmentReturnSharp]
            ["@material-ui/icons/AssignmentReturnTwoTone" :default AssignmentReturnTwoTone]
            ["@material-ui/icons/AssignmentRounded" :default AssignmentRounded]
            ["@material-ui/icons/AssignmentSharp" :default AssignmentSharp]
            ["@material-ui/icons/AssignmentTurnedIn" :default AssignmentTurnedIn]
            ["@material-ui/icons/AssignmentTurnedInOutlined" :default AssignmentTurnedInOutlined]
            ["@material-ui/icons/AssignmentTurnedInRounded" :default AssignmentTurnedInRounded]
            ["@material-ui/icons/AssignmentTurnedInSharp" :default AssignmentTurnedInSharp]
            ["@material-ui/icons/AssignmentTurnedInTwoTone" :default AssignmentTurnedInTwoTone]
            ["@material-ui/icons/AssignmentTwoTone" :default AssignmentTwoTone]
            ["@material-ui/icons/Assistant" :default Assistant]
            ["@material-ui/icons/AssistantOutlined" :default AssistantOutlined]
            ["@material-ui/icons/AssistantPhoto" :default AssistantPhoto]
            ["@material-ui/icons/AssistantPhotoOutlined" :default AssistantPhotoOutlined]
            ["@material-ui/icons/AssistantPhotoRounded" :default AssistantPhotoRounded]
            ["@material-ui/icons/AssistantPhotoSharp" :default AssistantPhotoSharp]
            ["@material-ui/icons/AssistantPhotoTwoTone" :default AssistantPhotoTwoTone]
            ["@material-ui/icons/AssistantRounded" :default AssistantRounded]
            ["@material-ui/icons/AssistantSharp" :default AssistantSharp]
            ["@material-ui/icons/AssistantTwoTone" :default AssistantTwoTone]
            ["@material-ui/icons/Atm" :default Atm]
            ["@material-ui/icons/AtmOutlined" :default AtmOutlined]
            ["@material-ui/icons/AtmRounded" :default AtmRounded]
            ["@material-ui/icons/AtmSharp" :default AtmSharp]
            ["@material-ui/icons/AtmTwoTone" :default AtmTwoTone]
            ["@material-ui/icons/AttachFile" :default AttachFile]
            ["@material-ui/icons/AttachFileOutlined" :default AttachFileOutlined]
            ["@material-ui/icons/AttachFileRounded" :default AttachFileRounded]
            ["@material-ui/icons/AttachFileSharp" :default AttachFileSharp]
            ["@material-ui/icons/AttachFileTwoTone" :default AttachFileTwoTone]
            ["@material-ui/icons/Attachment" :default Attachment]
            ["@material-ui/icons/AttachmentOutlined" :default AttachmentOutlined]
            ["@material-ui/icons/AttachmentRounded" :default AttachmentRounded]
            ["@material-ui/icons/AttachmentSharp" :default AttachmentSharp]
            ["@material-ui/icons/AttachmentTwoTone" :default AttachmentTwoTone]
            ["@material-ui/icons/AttachMoney" :default AttachMoney]
            ["@material-ui/icons/AttachMoneyOutlined" :default AttachMoneyOutlined]
            ["@material-ui/icons/AttachMoneyRounded" :default AttachMoneyRounded]
            ["@material-ui/icons/AttachMoneySharp" :default AttachMoneySharp]
            ["@material-ui/icons/AttachMoneyTwoTone" :default AttachMoneyTwoTone]
            ["@material-ui/icons/Audiotrack" :default Audiotrack]
            ["@material-ui/icons/AudiotrackOutlined" :default AudiotrackOutlined]
            ["@material-ui/icons/AudiotrackRounded" :default AudiotrackRounded]
            ["@material-ui/icons/AudiotrackSharp" :default AudiotrackSharp]
            ["@material-ui/icons/AudiotrackTwoTone" :default AudiotrackTwoTone]
            ["@material-ui/icons/Autorenew" :default Autorenew]
            ["@material-ui/icons/AutorenewOutlined" :default AutorenewOutlined]
            ["@material-ui/icons/AutorenewRounded" :default AutorenewRounded]
            ["@material-ui/icons/AutorenewSharp" :default AutorenewSharp]
            ["@material-ui/icons/AutorenewTwoTone" :default AutorenewTwoTone]
            ["@material-ui/icons/AvTimer" :default AvTimer]
            ["@material-ui/icons/AvTimerOutlined" :default AvTimerOutlined]
            ["@material-ui/icons/AvTimerRounded" :default AvTimerRounded]
            ["@material-ui/icons/AvTimerSharp" :default AvTimerSharp]
            ["@material-ui/icons/AvTimerTwoTone" :default AvTimerTwoTone]
            ["@material-ui/icons/Backspace" :default Backspace]
            ["@material-ui/icons/BackspaceOutlined" :default BackspaceOutlined]
            ["@material-ui/icons/BackspaceRounded" :default BackspaceRounded]
            ["@material-ui/icons/BackspaceSharp" :default BackspaceSharp]
            ["@material-ui/icons/BackspaceTwoTone" :default BackspaceTwoTone]
            ["@material-ui/icons/Backup" :default Backup]
            ["@material-ui/icons/BackupOutlined" :default BackupOutlined]
            ["@material-ui/icons/BackupRounded" :default BackupRounded]
            ["@material-ui/icons/BackupSharp" :default BackupSharp]
            ["@material-ui/icons/BackupTwoTone" :default BackupTwoTone]
            ["@material-ui/icons/Ballot" :default Ballot]
            ["@material-ui/icons/BallotOutlined" :default BallotOutlined]
            ["@material-ui/icons/BallotRounded" :default BallotRounded]
            ["@material-ui/icons/BallotSharp" :default BallotSharp]
            ["@material-ui/icons/BallotTwoTone" :default BallotTwoTone]
            ["@material-ui/icons/BarChart" :default BarChart]
            ["@material-ui/icons/BarChartOutlined" :default BarChartOutlined]
            ["@material-ui/icons/BarChartRounded" :default BarChartRounded]
            ["@material-ui/icons/BarChartSharp" :default BarChartSharp]
            ["@material-ui/icons/BarChartTwoTone" :default BarChartTwoTone]
            ["@material-ui/icons/Bathtub" :default Bathtub]
            ["@material-ui/icons/BathtubOutlined" :default BathtubOutlined]
            ["@material-ui/icons/BathtubRounded" :default BathtubRounded]
            ["@material-ui/icons/BathtubSharp" :default BathtubSharp]
            ["@material-ui/icons/BathtubTwoTone" :default BathtubTwoTone]
            ["@material-ui/icons/Battery20" :default Battery20]
            ["@material-ui/icons/Battery20Outlined" :default Battery20Outlined]
            ["@material-ui/icons/Battery20Rounded" :default Battery20Rounded]
            ["@material-ui/icons/Battery20Sharp" :default Battery20Sharp]
            ["@material-ui/icons/Battery20TwoTone" :default Battery20TwoTone]
            ["@material-ui/icons/Battery30" :default Battery30]
            ["@material-ui/icons/Battery30Outlined" :default Battery30Outlined]
            ["@material-ui/icons/Battery30Rounded" :default Battery30Rounded]
            ["@material-ui/icons/Battery30Sharp" :default Battery30Sharp]
            ["@material-ui/icons/Battery30TwoTone" :default Battery30TwoTone]
            ["@material-ui/icons/Battery50" :default Battery50]
            ["@material-ui/icons/Battery50Outlined" :default Battery50Outlined]
            ["@material-ui/icons/Battery50Rounded" :default Battery50Rounded]
            ["@material-ui/icons/Battery50Sharp" :default Battery50Sharp]
            ["@material-ui/icons/Battery50TwoTone" :default Battery50TwoTone]
            ["@material-ui/icons/Battery60" :default Battery60]
            ["@material-ui/icons/Battery60Outlined" :default Battery60Outlined]
            ["@material-ui/icons/Battery60Rounded" :default Battery60Rounded]
            ["@material-ui/icons/Battery60Sharp" :default Battery60Sharp]
            ["@material-ui/icons/Battery60TwoTone" :default Battery60TwoTone]
            ["@material-ui/icons/Battery80" :default Battery80]
            ["@material-ui/icons/Battery80Outlined" :default Battery80Outlined]
            ["@material-ui/icons/Battery80Rounded" :default Battery80Rounded]
            ["@material-ui/icons/Battery80Sharp" :default Battery80Sharp]
            ["@material-ui/icons/Battery80TwoTone" :default Battery80TwoTone]
            ["@material-ui/icons/Battery90" :default Battery90]
            ["@material-ui/icons/Battery90Outlined" :default Battery90Outlined]
            ["@material-ui/icons/Battery90Rounded" :default Battery90Rounded]
            ["@material-ui/icons/Battery90Sharp" :default Battery90Sharp]
            ["@material-ui/icons/Battery90TwoTone" :default Battery90TwoTone]
            ["@material-ui/icons/BatteryAlert" :default BatteryAlert]
            ["@material-ui/icons/BatteryAlertOutlined" :default BatteryAlertOutlined]
            ["@material-ui/icons/BatteryAlertRounded" :default BatteryAlertRounded]
            ["@material-ui/icons/BatteryAlertSharp" :default BatteryAlertSharp]
            ["@material-ui/icons/BatteryAlertTwoTone" :default BatteryAlertTwoTone]
            ["@material-ui/icons/BatteryCharging20" :default BatteryCharging20]
            ["@material-ui/icons/BatteryCharging20Outlined" :default BatteryCharging20Outlined]
            ["@material-ui/icons/BatteryCharging20Rounded" :default BatteryCharging20Rounded]
            ["@material-ui/icons/BatteryCharging20Sharp" :default BatteryCharging20Sharp]
            ["@material-ui/icons/BatteryCharging20TwoTone" :default BatteryCharging20TwoTone]
            ["@material-ui/icons/BatteryCharging30" :default BatteryCharging30]
            ["@material-ui/icons/BatteryCharging30Outlined" :default BatteryCharging30Outlined]
            ["@material-ui/icons/BatteryCharging30Rounded" :default BatteryCharging30Rounded]
            ["@material-ui/icons/BatteryCharging30Sharp" :default BatteryCharging30Sharp]
            ["@material-ui/icons/BatteryCharging30TwoTone" :default BatteryCharging30TwoTone]
            ["@material-ui/icons/BatteryCharging50" :default BatteryCharging50]
            ["@material-ui/icons/BatteryCharging50Outlined" :default BatteryCharging50Outlined]
            ["@material-ui/icons/BatteryCharging50Rounded" :default BatteryCharging50Rounded]
            ["@material-ui/icons/BatteryCharging50Sharp" :default BatteryCharging50Sharp]
            ["@material-ui/icons/BatteryCharging50TwoTone" :default BatteryCharging50TwoTone]
            ["@material-ui/icons/BatteryCharging60" :default BatteryCharging60]
            ["@material-ui/icons/BatteryCharging60Outlined" :default BatteryCharging60Outlined]
            ["@material-ui/icons/BatteryCharging60Rounded" :default BatteryCharging60Rounded]
            ["@material-ui/icons/BatteryCharging60Sharp" :default BatteryCharging60Sharp]
            ["@material-ui/icons/BatteryCharging60TwoTone" :default BatteryCharging60TwoTone]
            ["@material-ui/icons/BatteryCharging80" :default BatteryCharging80]
            ["@material-ui/icons/BatteryCharging80Outlined" :default BatteryCharging80Outlined]
            ["@material-ui/icons/BatteryCharging80Rounded" :default BatteryCharging80Rounded]
            ["@material-ui/icons/BatteryCharging80Sharp" :default BatteryCharging80Sharp]
            ["@material-ui/icons/BatteryCharging80TwoTone" :default BatteryCharging80TwoTone]
            ["@material-ui/icons/BatteryCharging90" :default BatteryCharging90]
            ["@material-ui/icons/BatteryCharging90Outlined" :default BatteryCharging90Outlined]
            ["@material-ui/icons/BatteryCharging90Rounded" :default BatteryCharging90Rounded]
            ["@material-ui/icons/BatteryCharging90Sharp" :default BatteryCharging90Sharp]
            ["@material-ui/icons/BatteryCharging90TwoTone" :default BatteryCharging90TwoTone]
            ["@material-ui/icons/BatteryChargingFull" :default BatteryChargingFull]
            ["@material-ui/icons/BatteryChargingFullOutlined" :default BatteryChargingFullOutlined]
            ["@material-ui/icons/BatteryChargingFullRounded" :default BatteryChargingFullRounded]
            ["@material-ui/icons/BatteryChargingFullSharp" :default BatteryChargingFullSharp]
            ["@material-ui/icons/BatteryChargingFullTwoTone" :default BatteryChargingFullTwoTone]
            ["@material-ui/icons/BatteryFull" :default BatteryFull]
            ["@material-ui/icons/BatteryFullOutlined" :default BatteryFullOutlined]
            ["@material-ui/icons/BatteryFullRounded" :default BatteryFullRounded]
            ["@material-ui/icons/BatteryFullSharp" :default BatteryFullSharp]
            ["@material-ui/icons/BatteryFullTwoTone" :default BatteryFullTwoTone]
            ["@material-ui/icons/BatteryStd" :default BatteryStd]
            ["@material-ui/icons/BatteryStdOutlined" :default BatteryStdOutlined]
            ["@material-ui/icons/BatteryStdRounded" :default BatteryStdRounded]
            ["@material-ui/icons/BatteryStdSharp" :default BatteryStdSharp]
            ["@material-ui/icons/BatteryStdTwoTone" :default BatteryStdTwoTone]
            ["@material-ui/icons/BatteryUnknown" :default BatteryUnknown]
            ["@material-ui/icons/BatteryUnknownOutlined" :default BatteryUnknownOutlined]
            ["@material-ui/icons/BatteryUnknownRounded" :default BatteryUnknownRounded]
            ["@material-ui/icons/BatteryUnknownSharp" :default BatteryUnknownSharp]
            ["@material-ui/icons/BatteryUnknownTwoTone" :default BatteryUnknownTwoTone]
            ["@material-ui/icons/BeachAccess" :default BeachAccess]
            ["@material-ui/icons/BeachAccessOutlined" :default BeachAccessOutlined]
            ["@material-ui/icons/BeachAccessRounded" :default BeachAccessRounded]
            ["@material-ui/icons/BeachAccessSharp" :default BeachAccessSharp]
            ["@material-ui/icons/BeachAccessTwoTone" :default BeachAccessTwoTone]
            ["@material-ui/icons/Beenhere" :default Beenhere]
            ["@material-ui/icons/BeenhereOutlined" :default BeenhereOutlined]
            ["@material-ui/icons/BeenhereRounded" :default BeenhereRounded]
            ["@material-ui/icons/BeenhereSharp" :default BeenhereSharp]
            ["@material-ui/icons/BeenhereTwoTone" :default BeenhereTwoTone]
            ["@material-ui/icons/Block" :default Block]
            ["@material-ui/icons/BlockOutlined" :default BlockOutlined]
            ["@material-ui/icons/BlockRounded" :default BlockRounded]
            ["@material-ui/icons/BlockSharp" :default BlockSharp]
            ["@material-ui/icons/BlockTwoTone" :default BlockTwoTone]
            ["@material-ui/icons/Bluetooth" :default Bluetooth]
            ["@material-ui/icons/BluetoothAudio" :default BluetoothAudio]
            ["@material-ui/icons/BluetoothAudioOutlined" :default BluetoothAudioOutlined]
            ["@material-ui/icons/BluetoothAudioRounded" :default BluetoothAudioRounded]
            ["@material-ui/icons/BluetoothAudioSharp" :default BluetoothAudioSharp]
            ["@material-ui/icons/BluetoothAudioTwoTone" :default BluetoothAudioTwoTone]
            ["@material-ui/icons/BluetoothConnected" :default BluetoothConnected]
            ["@material-ui/icons/BluetoothConnectedOutlined" :default BluetoothConnectedOutlined]
            ["@material-ui/icons/BluetoothConnectedRounded" :default BluetoothConnectedRounded]
            ["@material-ui/icons/BluetoothConnectedSharp" :default BluetoothConnectedSharp]
            ["@material-ui/icons/BluetoothConnectedTwoTone" :default BluetoothConnectedTwoTone]
            ["@material-ui/icons/BluetoothDisabled" :default BluetoothDisabled]
            ["@material-ui/icons/BluetoothDisabledOutlined" :default BluetoothDisabledOutlined]
            ["@material-ui/icons/BluetoothDisabledRounded" :default BluetoothDisabledRounded]
            ["@material-ui/icons/BluetoothDisabledSharp" :default BluetoothDisabledSharp]
            ["@material-ui/icons/BluetoothDisabledTwoTone" :default BluetoothDisabledTwoTone]
            ["@material-ui/icons/BluetoothOutlined" :default BluetoothOutlined]
            ["@material-ui/icons/BluetoothRounded" :default BluetoothRounded]
            ["@material-ui/icons/BluetoothSearching" :default BluetoothSearching]
            ["@material-ui/icons/BluetoothSearchingOutlined" :default BluetoothSearchingOutlined]
            ["@material-ui/icons/BluetoothSearchingRounded" :default BluetoothSearchingRounded]
            ["@material-ui/icons/BluetoothSearchingSharp" :default BluetoothSearchingSharp]
            ["@material-ui/icons/BluetoothSearchingTwoTone" :default BluetoothSearchingTwoTone]
            ["@material-ui/icons/BluetoothSharp" :default BluetoothSharp]
            ["@material-ui/icons/BluetoothTwoTone" :default BluetoothTwoTone]
            ["@material-ui/icons/BlurCircular" :default BlurCircular]
            ["@material-ui/icons/BlurCircularOutlined" :default BlurCircularOutlined]
            ["@material-ui/icons/BlurCircularRounded" :default BlurCircularRounded]
            ["@material-ui/icons/BlurCircularSharp" :default BlurCircularSharp]
            ["@material-ui/icons/BlurCircularTwoTone" :default BlurCircularTwoTone]
            ["@material-ui/icons/BlurLinear" :default BlurLinear]
            ["@material-ui/icons/BlurLinearOutlined" :default BlurLinearOutlined]
            ["@material-ui/icons/BlurLinearRounded" :default BlurLinearRounded]
            ["@material-ui/icons/BlurLinearSharp" :default BlurLinearSharp]
            ["@material-ui/icons/BlurLinearTwoTone" :default BlurLinearTwoTone]
            ["@material-ui/icons/BlurOff" :default BlurOff]
            ["@material-ui/icons/BlurOffOutlined" :default BlurOffOutlined]
            ["@material-ui/icons/BlurOffRounded" :default BlurOffRounded]
            ["@material-ui/icons/BlurOffSharp" :default BlurOffSharp]
            ["@material-ui/icons/BlurOffTwoTone" :default BlurOffTwoTone]
            ["@material-ui/icons/BlurOn" :default BlurOn]
            ["@material-ui/icons/BlurOnOutlined" :default BlurOnOutlined]
            ["@material-ui/icons/BlurOnRounded" :default BlurOnRounded]
            ["@material-ui/icons/BlurOnSharp" :default BlurOnSharp]
            ["@material-ui/icons/BlurOnTwoTone" :default BlurOnTwoTone]
            ["@material-ui/icons/Book" :default Book]
            ["@material-ui/icons/Bookmark" :default Bookmark]
            ["@material-ui/icons/BookmarkBorder" :default BookmarkBorder]
            ["@material-ui/icons/BookmarkBorderOutlined" :default BookmarkBorderOutlined]
            ["@material-ui/icons/BookmarkBorderRounded" :default BookmarkBorderRounded]
            ["@material-ui/icons/BookmarkBorderSharp" :default BookmarkBorderSharp]
            ["@material-ui/icons/BookmarkBorderTwoTone" :default BookmarkBorderTwoTone]
            ["@material-ui/icons/BookmarkOutlined" :default BookmarkOutlined]
            ["@material-ui/icons/BookmarkRounded" :default BookmarkRounded]
            ["@material-ui/icons/Bookmarks" :default Bookmarks]
            ["@material-ui/icons/BookmarkSharp" :default BookmarkSharp]
            ["@material-ui/icons/BookmarksOutlined" :default BookmarksOutlined]
            ["@material-ui/icons/BookmarksRounded" :default BookmarksRounded]
            ["@material-ui/icons/BookmarksSharp" :default BookmarksSharp]
            ["@material-ui/icons/BookmarksTwoTone" :default BookmarksTwoTone]
            ["@material-ui/icons/BookmarkTwoTone" :default BookmarkTwoTone]
            ["@material-ui/icons/BookOutlined" :default BookOutlined]
            ["@material-ui/icons/BookRounded" :default BookRounded]
            ["@material-ui/icons/BookSharp" :default BookSharp]
            ["@material-ui/icons/BookTwoTone" :default BookTwoTone]
            ["@material-ui/icons/BorderAll" :default BorderAll]
            ["@material-ui/icons/BorderAllOutlined" :default BorderAllOutlined]
            ["@material-ui/icons/BorderAllRounded" :default BorderAllRounded]
            ["@material-ui/icons/BorderAllSharp" :default BorderAllSharp]
            ["@material-ui/icons/BorderAllTwoTone" :default BorderAllTwoTone]
            ["@material-ui/icons/BorderBottom" :default BorderBottom]
            ["@material-ui/icons/BorderBottomOutlined" :default BorderBottomOutlined]
            ["@material-ui/icons/BorderBottomRounded" :default BorderBottomRounded]
            ["@material-ui/icons/BorderBottomSharp" :default BorderBottomSharp]
            ["@material-ui/icons/BorderBottomTwoTone" :default BorderBottomTwoTone]
            ["@material-ui/icons/BorderClear" :default BorderClear]
            ["@material-ui/icons/BorderClearOutlined" :default BorderClearOutlined]
            ["@material-ui/icons/BorderClearRounded" :default BorderClearRounded]
            ["@material-ui/icons/BorderClearSharp" :default BorderClearSharp]
            ["@material-ui/icons/BorderClearTwoTone" :default BorderClearTwoTone]
            ["@material-ui/icons/BorderColor" :default BorderColor]
            ["@material-ui/icons/BorderColorOutlined" :default BorderColorOutlined]
            ["@material-ui/icons/BorderColorRounded" :default BorderColorRounded]
            ["@material-ui/icons/BorderColorSharp" :default BorderColorSharp]
            ["@material-ui/icons/BorderColorTwoTone" :default BorderColorTwoTone]
            ["@material-ui/icons/BorderHorizontal" :default BorderHorizontal]
            ["@material-ui/icons/BorderHorizontalOutlined" :default BorderHorizontalOutlined]
            ["@material-ui/icons/BorderHorizontalRounded" :default BorderHorizontalRounded]
            ["@material-ui/icons/BorderHorizontalSharp" :default BorderHorizontalSharp]
            ["@material-ui/icons/BorderHorizontalTwoTone" :default BorderHorizontalTwoTone]
            ["@material-ui/icons/BorderInner" :default BorderInner]
            ["@material-ui/icons/BorderInnerOutlined" :default BorderInnerOutlined]
            ["@material-ui/icons/BorderInnerRounded" :default BorderInnerRounded]
            ["@material-ui/icons/BorderInnerSharp" :default BorderInnerSharp]
            ["@material-ui/icons/BorderInnerTwoTone" :default BorderInnerTwoTone]
            ["@material-ui/icons/BorderLeft" :default BorderLeft]
            ["@material-ui/icons/BorderLeftOutlined" :default BorderLeftOutlined]
            ["@material-ui/icons/BorderLeftRounded" :default BorderLeftRounded]
            ["@material-ui/icons/BorderLeftSharp" :default BorderLeftSharp]
            ["@material-ui/icons/BorderLeftTwoTone" :default BorderLeftTwoTone]
            ["@material-ui/icons/BorderOuter" :default BorderOuter]
            ["@material-ui/icons/BorderOuterOutlined" :default BorderOuterOutlined]
            ["@material-ui/icons/BorderOuterRounded" :default BorderOuterRounded]
            ["@material-ui/icons/BorderOuterSharp" :default BorderOuterSharp]
            ["@material-ui/icons/BorderOuterTwoTone" :default BorderOuterTwoTone]
            ["@material-ui/icons/BorderRight" :default BorderRight]
            ["@material-ui/icons/BorderRightOutlined" :default BorderRightOutlined]
            ["@material-ui/icons/BorderRightRounded" :default BorderRightRounded]
            ["@material-ui/icons/BorderRightSharp" :default BorderRightSharp]
            ["@material-ui/icons/BorderRightTwoTone" :default BorderRightTwoTone]
            ["@material-ui/icons/BorderStyle" :default BorderStyle]
            ["@material-ui/icons/BorderStyleOutlined" :default BorderStyleOutlined]
            ["@material-ui/icons/BorderStyleRounded" :default BorderStyleRounded]
            ["@material-ui/icons/BorderStyleSharp" :default BorderStyleSharp]
            ["@material-ui/icons/BorderStyleTwoTone" :default BorderStyleTwoTone]
            ["@material-ui/icons/BorderTop" :default BorderTop]
            ["@material-ui/icons/BorderTopOutlined" :default BorderTopOutlined]
            ["@material-ui/icons/BorderTopRounded" :default BorderTopRounded]
            ["@material-ui/icons/BorderTopSharp" :default BorderTopSharp]
            ["@material-ui/icons/BorderTopTwoTone" :default BorderTopTwoTone]
            ["@material-ui/icons/BorderVertical" :default BorderVertical]
            ["@material-ui/icons/BorderVerticalOutlined" :default BorderVerticalOutlined]
            ["@material-ui/icons/BorderVerticalRounded" :default BorderVerticalRounded]
            ["@material-ui/icons/BorderVerticalSharp" :default BorderVerticalSharp]
            ["@material-ui/icons/BorderVerticalTwoTone" :default BorderVerticalTwoTone]
            ["@material-ui/icons/BrandingWatermark" :default BrandingWatermark]
            ["@material-ui/icons/BrandingWatermarkOutlined" :default BrandingWatermarkOutlined]
            ["@material-ui/icons/BrandingWatermarkRounded" :default BrandingWatermarkRounded]
            ["@material-ui/icons/BrandingWatermarkSharp" :default BrandingWatermarkSharp]
            ["@material-ui/icons/BrandingWatermarkTwoTone" :default BrandingWatermarkTwoTone]
            ["@material-ui/icons/Brightness1" :default Brightness1]
            ["@material-ui/icons/Brightness1Outlined" :default Brightness1Outlined]
            ["@material-ui/icons/Brightness1Rounded" :default Brightness1Rounded]
            ["@material-ui/icons/Brightness1Sharp" :default Brightness1Sharp]
            ["@material-ui/icons/Brightness1TwoTone" :default Brightness1TwoTone]
            ["@material-ui/icons/Brightness2" :default Brightness2]
            ["@material-ui/icons/Brightness2Outlined" :default Brightness2Outlined]
            ["@material-ui/icons/Brightness2Rounded" :default Brightness2Rounded]
            ["@material-ui/icons/Brightness2Sharp" :default Brightness2Sharp]
            ["@material-ui/icons/Brightness2TwoTone" :default Brightness2TwoTone]
            ["@material-ui/icons/Brightness3" :default Brightness3]
            ["@material-ui/icons/Brightness3Outlined" :default Brightness3Outlined]
            ["@material-ui/icons/Brightness3Rounded" :default Brightness3Rounded]
            ["@material-ui/icons/Brightness3Sharp" :default Brightness3Sharp]
            ["@material-ui/icons/Brightness3TwoTone" :default Brightness3TwoTone]
            ["@material-ui/icons/Brightness4" :default Brightness4]
            ["@material-ui/icons/Brightness4Outlined" :default Brightness4Outlined]
            ["@material-ui/icons/Brightness4Rounded" :default Brightness4Rounded]
            ["@material-ui/icons/Brightness4Sharp" :default Brightness4Sharp]
            ["@material-ui/icons/Brightness4TwoTone" :default Brightness4TwoTone]
            ["@material-ui/icons/Brightness5" :default Brightness5]
            ["@material-ui/icons/Brightness5Outlined" :default Brightness5Outlined]
            ["@material-ui/icons/Brightness5Rounded" :default Brightness5Rounded]
            ["@material-ui/icons/Brightness5Sharp" :default Brightness5Sharp]
            ["@material-ui/icons/Brightness5TwoTone" :default Brightness5TwoTone]
            ["@material-ui/icons/Brightness6" :default Brightness6]
            ["@material-ui/icons/Brightness6Outlined" :default Brightness6Outlined]
            ["@material-ui/icons/Brightness6Rounded" :default Brightness6Rounded]
            ["@material-ui/icons/Brightness6Sharp" :default Brightness6Sharp]
            ["@material-ui/icons/Brightness6TwoTone" :default Brightness6TwoTone]
            ["@material-ui/icons/Brightness7" :default Brightness7]
            ["@material-ui/icons/Brightness7Outlined" :default Brightness7Outlined]
            ["@material-ui/icons/Brightness7Rounded" :default Brightness7Rounded]
            ["@material-ui/icons/Brightness7Sharp" :default Brightness7Sharp]
            ["@material-ui/icons/Brightness7TwoTone" :default Brightness7TwoTone]
            ["@material-ui/icons/BrightnessAuto" :default BrightnessAuto]
            ["@material-ui/icons/BrightnessAutoOutlined" :default BrightnessAutoOutlined]
            ["@material-ui/icons/BrightnessAutoRounded" :default BrightnessAutoRounded]
            ["@material-ui/icons/BrightnessAutoSharp" :default BrightnessAutoSharp]
            ["@material-ui/icons/BrightnessAutoTwoTone" :default BrightnessAutoTwoTone]
            ["@material-ui/icons/BrightnessHigh" :default BrightnessHigh]
            ["@material-ui/icons/BrightnessHighOutlined" :default BrightnessHighOutlined]
            ["@material-ui/icons/BrightnessHighRounded" :default BrightnessHighRounded]
            ["@material-ui/icons/BrightnessHighSharp" :default BrightnessHighSharp]
            ["@material-ui/icons/BrightnessHighTwoTone" :default BrightnessHighTwoTone]
            ["@material-ui/icons/BrightnessLow" :default BrightnessLow]
            ["@material-ui/icons/BrightnessLowOutlined" :default BrightnessLowOutlined]
            ["@material-ui/icons/BrightnessLowRounded" :default BrightnessLowRounded]
            ["@material-ui/icons/BrightnessLowSharp" :default BrightnessLowSharp]
            ["@material-ui/icons/BrightnessLowTwoTone" :default BrightnessLowTwoTone]
            ["@material-ui/icons/BrightnessMedium" :default BrightnessMedium]
            ["@material-ui/icons/BrightnessMediumOutlined" :default BrightnessMediumOutlined]
            ["@material-ui/icons/BrightnessMediumRounded" :default BrightnessMediumRounded]
            ["@material-ui/icons/BrightnessMediumSharp" :default BrightnessMediumSharp]
            ["@material-ui/icons/BrightnessMediumTwoTone" :default BrightnessMediumTwoTone]
            ["@material-ui/icons/BrokenImage" :default BrokenImage]
            ["@material-ui/icons/BrokenImageOutlined" :default BrokenImageOutlined]
            ["@material-ui/icons/BrokenImageRounded" :default BrokenImageRounded]
            ["@material-ui/icons/BrokenImageSharp" :default BrokenImageSharp]
            ["@material-ui/icons/BrokenImageTwoTone" :default BrokenImageTwoTone]
            ["@material-ui/icons/Brush" :default Brush]
            ["@material-ui/icons/BrushOutlined" :default BrushOutlined]
            ["@material-ui/icons/BrushRounded" :default BrushRounded]
            ["@material-ui/icons/BrushSharp" :default BrushSharp]
            ["@material-ui/icons/BrushTwoTone" :default BrushTwoTone]
            ["@material-ui/icons/BubbleChart" :default BubbleChart]
            ["@material-ui/icons/BubbleChartOutlined" :default BubbleChartOutlined]
            ["@material-ui/icons/BubbleChartRounded" :default BubbleChartRounded]
            ["@material-ui/icons/BubbleChartSharp" :default BubbleChartSharp]
            ["@material-ui/icons/BubbleChartTwoTone" :default BubbleChartTwoTone]
            ["@material-ui/icons/BugReport" :default BugReport]
            ["@material-ui/icons/BugReportOutlined" :default BugReportOutlined]
            ["@material-ui/icons/BugReportRounded" :default BugReportRounded]
            ["@material-ui/icons/BugReportSharp" :default BugReportSharp]
            ["@material-ui/icons/BugReportTwoTone" :default BugReportTwoTone]
            ["@material-ui/icons/Build" :default Build]
            ["@material-ui/icons/BuildOutlined" :default BuildOutlined]
            ["@material-ui/icons/BuildRounded" :default BuildRounded]
            ["@material-ui/icons/BuildSharp" :default BuildSharp]
            ["@material-ui/icons/BuildTwoTone" :default BuildTwoTone]
            ["@material-ui/icons/BurstMode" :default BurstMode]
            ["@material-ui/icons/BurstModeOutlined" :default BurstModeOutlined]
            ["@material-ui/icons/BurstModeRounded" :default BurstModeRounded]
            ["@material-ui/icons/BurstModeSharp" :default BurstModeSharp]
            ["@material-ui/icons/BurstModeTwoTone" :default BurstModeTwoTone]
            ["@material-ui/icons/Business" :default Business]
            ["@material-ui/icons/BusinessCenter" :default BusinessCenter]
            ["@material-ui/icons/BusinessCenterOutlined" :default BusinessCenterOutlined]
            ["@material-ui/icons/BusinessCenterRounded" :default BusinessCenterRounded]
            ["@material-ui/icons/BusinessCenterSharp" :default BusinessCenterSharp]
            ["@material-ui/icons/BusinessCenterTwoTone" :default BusinessCenterTwoTone]
            ["@material-ui/icons/BusinessOutlined" :default BusinessOutlined]
            ["@material-ui/icons/BusinessRounded" :default BusinessRounded]
            ["@material-ui/icons/BusinessSharp" :default BusinessSharp]
            ["@material-ui/icons/BusinessTwoTone" :default BusinessTwoTone]
            ["@material-ui/icons/Cached" :default Cached]
            ["@material-ui/icons/CachedOutlined" :default CachedOutlined]
            ["@material-ui/icons/CachedRounded" :default CachedRounded]
            ["@material-ui/icons/CachedSharp" :default CachedSharp]
            ["@material-ui/icons/CachedTwoTone" :default CachedTwoTone]
            ["@material-ui/icons/Cake" :default Cake]
            ["@material-ui/icons/CakeOutlined" :default CakeOutlined]
            ["@material-ui/icons/CakeRounded" :default CakeRounded]
            ["@material-ui/icons/CakeSharp" :default CakeSharp]
            ["@material-ui/icons/CakeTwoTone" :default CakeTwoTone]
            ["@material-ui/icons/CalendarToday" :default CalendarToday]
            ["@material-ui/icons/CalendarTodayOutlined" :default CalendarTodayOutlined]
            ["@material-ui/icons/CalendarTodayRounded" :default CalendarTodayRounded]
            ["@material-ui/icons/CalendarTodaySharp" :default CalendarTodaySharp]
            ["@material-ui/icons/CalendarTodayTwoTone" :default CalendarTodayTwoTone]
            ["@material-ui/icons/CalendarViewDay" :default CalendarViewDay]
            ["@material-ui/icons/CalendarViewDayOutlined" :default CalendarViewDayOutlined]
            ["@material-ui/icons/CalendarViewDayRounded" :default CalendarViewDayRounded]
            ["@material-ui/icons/CalendarViewDaySharp" :default CalendarViewDaySharp]
            ["@material-ui/icons/CalendarViewDayTwoTone" :default CalendarViewDayTwoTone]
            ["@material-ui/icons/Call" :default Call]
            ["@material-ui/icons/CallEnd" :default CallEnd]
            ["@material-ui/icons/CallEndOutlined" :default CallEndOutlined]
            ["@material-ui/icons/CallEndRounded" :default CallEndRounded]
            ["@material-ui/icons/CallEndSharp" :default CallEndSharp]
            ["@material-ui/icons/CallEndTwoTone" :default CallEndTwoTone]
            ["@material-ui/icons/CallMade" :default CallMade]
            ["@material-ui/icons/CallMadeOutlined" :default CallMadeOutlined]
            ["@material-ui/icons/CallMadeRounded" :default CallMadeRounded]
            ["@material-ui/icons/CallMadeSharp" :default CallMadeSharp]
            ["@material-ui/icons/CallMadeTwoTone" :default CallMadeTwoTone]
            ["@material-ui/icons/CallMerge" :default CallMerge]
            ["@material-ui/icons/CallMergeOutlined" :default CallMergeOutlined]
            ["@material-ui/icons/CallMergeRounded" :default CallMergeRounded]
            ["@material-ui/icons/CallMergeSharp" :default CallMergeSharp]
            ["@material-ui/icons/CallMergeTwoTone" :default CallMergeTwoTone]
            ["@material-ui/icons/CallMissed" :default CallMissed]
            ["@material-ui/icons/CallMissedOutgoing" :default CallMissedOutgoing]
            ["@material-ui/icons/CallMissedOutgoingOutlined" :default CallMissedOutgoingOutlined]
            ["@material-ui/icons/CallMissedOutgoingRounded" :default CallMissedOutgoingRounded]
            ["@material-ui/icons/CallMissedOutgoingSharp" :default CallMissedOutgoingSharp]
            ["@material-ui/icons/CallMissedOutgoingTwoTone" :default CallMissedOutgoingTwoTone]
            ["@material-ui/icons/CallMissedOutlined" :default CallMissedOutlined]
            ["@material-ui/icons/CallMissedRounded" :default CallMissedRounded]
            ["@material-ui/icons/CallMissedSharp" :default CallMissedSharp]
            ["@material-ui/icons/CallMissedTwoTone" :default CallMissedTwoTone]
            ["@material-ui/icons/CallOutlined" :default CallOutlined]
            ["@material-ui/icons/CallReceived" :default CallReceived]
            ["@material-ui/icons/CallReceivedOutlined" :default CallReceivedOutlined]
            ["@material-ui/icons/CallReceivedRounded" :default CallReceivedRounded]
            ["@material-ui/icons/CallReceivedSharp" :default CallReceivedSharp]
            ["@material-ui/icons/CallReceivedTwoTone" :default CallReceivedTwoTone]
            ["@material-ui/icons/CallRounded" :default CallRounded]
            ["@material-ui/icons/CallSharp" :default CallSharp]
            ["@material-ui/icons/CallSplit" :default CallSplit]
            ["@material-ui/icons/CallSplitOutlined" :default CallSplitOutlined]
            ["@material-ui/icons/CallSplitRounded" :default CallSplitRounded]
            ["@material-ui/icons/CallSplitSharp" :default CallSplitSharp]
            ["@material-ui/icons/CallSplitTwoTone" :default CallSplitTwoTone]
            ["@material-ui/icons/CallToAction" :default CallToAction]
            ["@material-ui/icons/CallToActionOutlined" :default CallToActionOutlined]
            ["@material-ui/icons/CallToActionRounded" :default CallToActionRounded]
            ["@material-ui/icons/CallToActionSharp" :default CallToActionSharp]
            ["@material-ui/icons/CallToActionTwoTone" :default CallToActionTwoTone]
            ["@material-ui/icons/CallTwoTone" :default CallTwoTone]
            ["@material-ui/icons/Camera" :default Camera]
            ["@material-ui/icons/CameraAlt" :default CameraAlt]
            ["@material-ui/icons/CameraAltOutlined" :default CameraAltOutlined]
            ["@material-ui/icons/CameraAltRounded" :default CameraAltRounded]
            ["@material-ui/icons/CameraAltSharp" :default CameraAltSharp]
            ["@material-ui/icons/CameraAltTwoTone" :default CameraAltTwoTone]
            ["@material-ui/icons/CameraEnhance" :default CameraEnhance]
            ["@material-ui/icons/CameraEnhanceOutlined" :default CameraEnhanceOutlined]
            ["@material-ui/icons/CameraEnhanceRounded" :default CameraEnhanceRounded]
            ["@material-ui/icons/CameraEnhanceSharp" :default CameraEnhanceSharp]
            ["@material-ui/icons/CameraEnhanceTwoTone" :default CameraEnhanceTwoTone]
            ["@material-ui/icons/CameraFront" :default CameraFront]
            ["@material-ui/icons/CameraFrontOutlined" :default CameraFrontOutlined]
            ["@material-ui/icons/CameraFrontRounded" :default CameraFrontRounded]
            ["@material-ui/icons/CameraFrontSharp" :default CameraFrontSharp]
            ["@material-ui/icons/CameraFrontTwoTone" :default CameraFrontTwoTone]
            ["@material-ui/icons/CameraOutlined" :default CameraOutlined]
            ["@material-ui/icons/CameraRear" :default CameraRear]
            ["@material-ui/icons/CameraRearOutlined" :default CameraRearOutlined]
            ["@material-ui/icons/CameraRearRounded" :default CameraRearRounded]
            ["@material-ui/icons/CameraRearSharp" :default CameraRearSharp]
            ["@material-ui/icons/CameraRearTwoTone" :default CameraRearTwoTone]
            ["@material-ui/icons/CameraRoll" :default CameraRoll]
            ["@material-ui/icons/CameraRollOutlined" :default CameraRollOutlined]
            ["@material-ui/icons/CameraRollRounded" :default CameraRollRounded]
            ["@material-ui/icons/CameraRollSharp" :default CameraRollSharp]
            ["@material-ui/icons/CameraRollTwoTone" :default CameraRollTwoTone]
            ["@material-ui/icons/CameraRounded" :default CameraRounded]
            ["@material-ui/icons/CameraSharp" :default CameraSharp]
            ["@material-ui/icons/CameraTwoTone" :default CameraTwoTone]
            ["@material-ui/icons/Cancel" :default Cancel]
            ["@material-ui/icons/CancelOutlined" :default CancelOutlined]
            ["@material-ui/icons/CancelPresentation" :default CancelPresentation]
            ["@material-ui/icons/CancelPresentationOutlined" :default CancelPresentationOutlined]
            ["@material-ui/icons/CancelPresentationRounded" :default CancelPresentationRounded]
            ["@material-ui/icons/CancelPresentationSharp" :default CancelPresentationSharp]
            ["@material-ui/icons/CancelPresentationTwoTone" :default CancelPresentationTwoTone]
            ["@material-ui/icons/CancelRounded" :default CancelRounded]
            ["@material-ui/icons/CancelScheduleSend" :default CancelScheduleSend]
            ["@material-ui/icons/CancelScheduleSendOutlined" :default CancelScheduleSendOutlined]
            ["@material-ui/icons/CancelScheduleSendRounded" :default CancelScheduleSendRounded]
            ["@material-ui/icons/CancelScheduleSendSharp" :default CancelScheduleSendSharp]
            ["@material-ui/icons/CancelScheduleSendTwoTone" :default CancelScheduleSendTwoTone]
            ["@material-ui/icons/CancelSharp" :default CancelSharp]
            ["@material-ui/icons/CancelTwoTone" :default CancelTwoTone]
            ["@material-ui/icons/CardGiftcard" :default CardGiftcard]
            ["@material-ui/icons/CardGiftcardOutlined" :default CardGiftcardOutlined]
            ["@material-ui/icons/CardGiftcardRounded" :default CardGiftcardRounded]
            ["@material-ui/icons/CardGiftcardSharp" :default CardGiftcardSharp]
            ["@material-ui/icons/CardGiftcardTwoTone" :default CardGiftcardTwoTone]
            ["@material-ui/icons/CardMembership" :default CardMembership]
            ["@material-ui/icons/CardMembershipOutlined" :default CardMembershipOutlined]
            ["@material-ui/icons/CardMembershipRounded" :default CardMembershipRounded]
            ["@material-ui/icons/CardMembershipSharp" :default CardMembershipSharp]
            ["@material-ui/icons/CardMembershipTwoTone" :default CardMembershipTwoTone]
            ["@material-ui/icons/CardTravel" :default CardTravel]
            ["@material-ui/icons/CardTravelOutlined" :default CardTravelOutlined]
            ["@material-ui/icons/CardTravelRounded" :default CardTravelRounded]
            ["@material-ui/icons/CardTravelSharp" :default CardTravelSharp]
            ["@material-ui/icons/CardTravelTwoTone" :default CardTravelTwoTone]
            ["@material-ui/icons/Casino" :default Casino]
            ["@material-ui/icons/CasinoOutlined" :default CasinoOutlined]
            ["@material-ui/icons/CasinoRounded" :default CasinoRounded]
            ["@material-ui/icons/CasinoSharp" :default CasinoSharp]
            ["@material-ui/icons/CasinoTwoTone" :default CasinoTwoTone]
            ["@material-ui/icons/Cast" :default Cast]
            ["@material-ui/icons/CastConnected" :default CastConnected]
            ["@material-ui/icons/CastConnectedOutlined" :default CastConnectedOutlined]
            ["@material-ui/icons/CastConnectedRounded" :default CastConnectedRounded]
            ["@material-ui/icons/CastConnectedSharp" :default CastConnectedSharp]
            ["@material-ui/icons/CastConnectedTwoTone" :default CastConnectedTwoTone]
            ["@material-ui/icons/CastForEducation" :default CastForEducation]
            ["@material-ui/icons/CastForEducationOutlined" :default CastForEducationOutlined]
            ["@material-ui/icons/CastForEducationRounded" :default CastForEducationRounded]
            ["@material-ui/icons/CastForEducationSharp" :default CastForEducationSharp]
            ["@material-ui/icons/CastForEducationTwoTone" :default CastForEducationTwoTone]
            ["@material-ui/icons/CastOutlined" :default CastOutlined]
            ["@material-ui/icons/CastRounded" :default CastRounded]
            ["@material-ui/icons/CastSharp" :default CastSharp]
            ["@material-ui/icons/CastTwoTone" :default CastTwoTone]
            ["@material-ui/icons/Category" :default Category]
            ["@material-ui/icons/CategoryOutlined" :default CategoryOutlined]
            ["@material-ui/icons/CategoryRounded" :default CategoryRounded]
            ["@material-ui/icons/CategorySharp" :default CategorySharp]
            ["@material-ui/icons/CategoryTwoTone" :default CategoryTwoTone]
            ["@material-ui/icons/CellWifi" :default CellWifi]
            ["@material-ui/icons/CellWifiOutlined" :default CellWifiOutlined]
            ["@material-ui/icons/CellWifiRounded" :default CellWifiRounded]
            ["@material-ui/icons/CellWifiSharp" :default CellWifiSharp]
            ["@material-ui/icons/CellWifiTwoTone" :default CellWifiTwoTone]
            ["@material-ui/icons/CenterFocusStrong" :default CenterFocusStrong]
            ["@material-ui/icons/CenterFocusStrongOutlined" :default CenterFocusStrongOutlined]
            ["@material-ui/icons/CenterFocusStrongRounded" :default CenterFocusStrongRounded]
            ["@material-ui/icons/CenterFocusStrongSharp" :default CenterFocusStrongSharp]
            ["@material-ui/icons/CenterFocusStrongTwoTone" :default CenterFocusStrongTwoTone]
            ["@material-ui/icons/CenterFocusWeak" :default CenterFocusWeak]
            ["@material-ui/icons/CenterFocusWeakOutlined" :default CenterFocusWeakOutlined]
            ["@material-ui/icons/CenterFocusWeakRounded" :default CenterFocusWeakRounded]
            ["@material-ui/icons/CenterFocusWeakSharp" :default CenterFocusWeakSharp]
            ["@material-ui/icons/CenterFocusWeakTwoTone" :default CenterFocusWeakTwoTone]
            ["@material-ui/icons/ChangeHistory" :default ChangeHistory]
            ["@material-ui/icons/ChangeHistoryOutlined" :default ChangeHistoryOutlined]
            ["@material-ui/icons/ChangeHistoryRounded" :default ChangeHistoryRounded]
            ["@material-ui/icons/ChangeHistorySharp" :default ChangeHistorySharp]
            ["@material-ui/icons/ChangeHistoryTwoTone" :default ChangeHistoryTwoTone]
            ["@material-ui/icons/Chat" :default Chat]
            ["@material-ui/icons/ChatBubble" :default ChatBubble]
            ["@material-ui/icons/ChatBubbleOutline" :default ChatBubbleOutline]
            ["@material-ui/icons/ChatBubbleOutlined" :default ChatBubbleOutlined]
            ["@material-ui/icons/ChatBubbleOutlineOutlined" :default ChatBubbleOutlineOutlined]
            ["@material-ui/icons/ChatBubbleOutlineRounded" :default ChatBubbleOutlineRounded]
            ["@material-ui/icons/ChatBubbleOutlineSharp" :default ChatBubbleOutlineSharp]
            ["@material-ui/icons/ChatBubbleOutlineTwoTone" :default ChatBubbleOutlineTwoTone]
            ["@material-ui/icons/ChatBubbleRounded" :default ChatBubbleRounded]
            ["@material-ui/icons/ChatBubbleSharp" :default ChatBubbleSharp]
            ["@material-ui/icons/ChatBubbleTwoTone" :default ChatBubbleTwoTone]
            ["@material-ui/icons/ChatOutlined" :default ChatOutlined]
            ["@material-ui/icons/ChatRounded" :default ChatRounded]
            ["@material-ui/icons/ChatSharp" :default ChatSharp]
            ["@material-ui/icons/ChatTwoTone" :default ChatTwoTone]
            ["@material-ui/icons/Check" :default Check]
            ["@material-ui/icons/CheckBox" :default CheckBox]
            ["@material-ui/icons/CheckBoxOutlineBlank" :default CheckBoxOutlineBlank]
            ["@material-ui/icons/CheckBoxOutlineBlankOutlined" :default CheckBoxOutlineBlankOutlined]
            ["@material-ui/icons/CheckBoxOutlineBlankRounded" :default CheckBoxOutlineBlankRounded]
            ["@material-ui/icons/CheckBoxOutlineBlankSharp" :default CheckBoxOutlineBlankSharp]
            ["@material-ui/icons/CheckBoxOutlineBlankTwoTone" :default CheckBoxOutlineBlankTwoTone]
            ["@material-ui/icons/CheckBoxOutlined" :default CheckBoxOutlined]
            ["@material-ui/icons/CheckBoxRounded" :default CheckBoxRounded]
            ["@material-ui/icons/CheckBoxSharp" :default CheckBoxSharp]
            ["@material-ui/icons/CheckBoxTwoTone" :default CheckBoxTwoTone]
            ["@material-ui/icons/CheckCircle" :default CheckCircle]
            ["@material-ui/icons/CheckCircleOutline" :default CheckCircleOutline]
            ["@material-ui/icons/CheckCircleOutlined" :default CheckCircleOutlined]
            ["@material-ui/icons/CheckCircleOutlineOutlined" :default CheckCircleOutlineOutlined]
            ["@material-ui/icons/CheckCircleOutlineRounded" :default CheckCircleOutlineRounded]
            ["@material-ui/icons/CheckCircleOutlineSharp" :default CheckCircleOutlineSharp]
            ["@material-ui/icons/CheckCircleOutlineTwoTone" :default CheckCircleOutlineTwoTone]
            ["@material-ui/icons/CheckCircleRounded" :default CheckCircleRounded]
            ["@material-ui/icons/CheckCircleSharp" :default CheckCircleSharp]
            ["@material-ui/icons/CheckCircleTwoTone" :default CheckCircleTwoTone]
            ["@material-ui/icons/CheckOutlined" :default CheckOutlined]
            ["@material-ui/icons/CheckRounded" :default CheckRounded]
            ["@material-ui/icons/CheckSharp" :default CheckSharp]
            ["@material-ui/icons/CheckTwoTone" :default CheckTwoTone]
            ["@material-ui/icons/ChevronLeft" :default ChevronLeft]
            ["@material-ui/icons/ChevronLeftOutlined" :default ChevronLeftOutlined]
            ["@material-ui/icons/ChevronLeftRounded" :default ChevronLeftRounded]
            ["@material-ui/icons/ChevronLeftSharp" :default ChevronLeftSharp]
            ["@material-ui/icons/ChevronLeftTwoTone" :default ChevronLeftTwoTone]
            ["@material-ui/icons/ChevronRight" :default ChevronRight]
            ["@material-ui/icons/ChevronRightOutlined" :default ChevronRightOutlined]
            ["@material-ui/icons/ChevronRightRounded" :default ChevronRightRounded]
            ["@material-ui/icons/ChevronRightSharp" :default ChevronRightSharp]
            ["@material-ui/icons/ChevronRightTwoTone" :default ChevronRightTwoTone]
            ["@material-ui/icons/ChildCare" :default ChildCare]
            ["@material-ui/icons/ChildCareOutlined" :default ChildCareOutlined]
            ["@material-ui/icons/ChildCareRounded" :default ChildCareRounded]
            ["@material-ui/icons/ChildCareSharp" :default ChildCareSharp]
            ["@material-ui/icons/ChildCareTwoTone" :default ChildCareTwoTone]
            ["@material-ui/icons/ChildFriendly" :default ChildFriendly]
            ["@material-ui/icons/ChildFriendlyOutlined" :default ChildFriendlyOutlined]
            ["@material-ui/icons/ChildFriendlyRounded" :default ChildFriendlyRounded]
            ["@material-ui/icons/ChildFriendlySharp" :default ChildFriendlySharp]
            ["@material-ui/icons/ChildFriendlyTwoTone" :default ChildFriendlyTwoTone]
            ["@material-ui/icons/ChromeReaderMode" :default ChromeReaderMode]
            ["@material-ui/icons/ChromeReaderModeOutlined" :default ChromeReaderModeOutlined]
            ["@material-ui/icons/ChromeReaderModeRounded" :default ChromeReaderModeRounded]
            ["@material-ui/icons/ChromeReaderModeSharp" :default ChromeReaderModeSharp]
            ["@material-ui/icons/ChromeReaderModeTwoTone" :default ChromeReaderModeTwoTone]
            ["@material-ui/icons/Class" :default Class]
            ["@material-ui/icons/ClassOutlined" :default ClassOutlined]
            ["@material-ui/icons/ClassRounded" :default ClassRounded]
            ["@material-ui/icons/ClassSharp" :default ClassSharp]
            ["@material-ui/icons/ClassTwoTone" :default ClassTwoTone]
            ["@material-ui/icons/Clear" :default Clear]
            ["@material-ui/icons/ClearAll" :default ClearAll]
            ["@material-ui/icons/ClearAllOutlined" :default ClearAllOutlined]
            ["@material-ui/icons/ClearAllRounded" :default ClearAllRounded]
            ["@material-ui/icons/ClearAllSharp" :default ClearAllSharp]
            ["@material-ui/icons/ClearAllTwoTone" :default ClearAllTwoTone]
            ["@material-ui/icons/ClearOutlined" :default ClearOutlined]
            ["@material-ui/icons/ClearRounded" :default ClearRounded]
            ["@material-ui/icons/ClearSharp" :default ClearSharp]
            ["@material-ui/icons/ClearTwoTone" :default ClearTwoTone]
            ["@material-ui/icons/Close" :default Close]
            ["@material-ui/icons/ClosedCaption" :default ClosedCaption]
            ["@material-ui/icons/ClosedCaptionOutlined" :default ClosedCaptionOutlined]
            ["@material-ui/icons/ClosedCaptionRounded" :default ClosedCaptionRounded]
            ["@material-ui/icons/ClosedCaptionSharp" :default ClosedCaptionSharp]
            ["@material-ui/icons/ClosedCaptionTwoTone" :default ClosedCaptionTwoTone]
            ["@material-ui/icons/CloseOutlined" :default CloseOutlined]
            ["@material-ui/icons/CloseRounded" :default CloseRounded]
            ["@material-ui/icons/CloseSharp" :default CloseSharp]
            ["@material-ui/icons/CloseTwoTone" :default CloseTwoTone]
            ["@material-ui/icons/Cloud" :default Cloud]
            ["@material-ui/icons/CloudCircle" :default CloudCircle]
            ["@material-ui/icons/CloudCircleOutlined" :default CloudCircleOutlined]
            ["@material-ui/icons/CloudCircleRounded" :default CloudCircleRounded]
            ["@material-ui/icons/CloudCircleSharp" :default CloudCircleSharp]
            ["@material-ui/icons/CloudCircleTwoTone" :default CloudCircleTwoTone]
            ["@material-ui/icons/CloudDone" :default CloudDone]
            ["@material-ui/icons/CloudDoneOutlined" :default CloudDoneOutlined]
            ["@material-ui/icons/CloudDoneRounded" :default CloudDoneRounded]
            ["@material-ui/icons/CloudDoneSharp" :default CloudDoneSharp]
            ["@material-ui/icons/CloudDoneTwoTone" :default CloudDoneTwoTone]
            ["@material-ui/icons/CloudDownload" :default CloudDownload]
            ["@material-ui/icons/CloudDownloadOutlined" :default CloudDownloadOutlined]
            ["@material-ui/icons/CloudDownloadRounded" :default CloudDownloadRounded]
            ["@material-ui/icons/CloudDownloadSharp" :default CloudDownloadSharp]
            ["@material-ui/icons/CloudDownloadTwoTone" :default CloudDownloadTwoTone]
            ["@material-ui/icons/CloudOff" :default CloudOff]
            ["@material-ui/icons/CloudOffOutlined" :default CloudOffOutlined]
            ["@material-ui/icons/CloudOffRounded" :default CloudOffRounded]
            ["@material-ui/icons/CloudOffSharp" :default CloudOffSharp]
            ["@material-ui/icons/CloudOffTwoTone" :default CloudOffTwoTone]
            ["@material-ui/icons/CloudOutlined" :default CloudOutlined]
            ["@material-ui/icons/CloudQueue" :default CloudQueue]
            ["@material-ui/icons/CloudQueueOutlined" :default CloudQueueOutlined]
            ["@material-ui/icons/CloudQueueRounded" :default CloudQueueRounded]
            ["@material-ui/icons/CloudQueueSharp" :default CloudQueueSharp]
            ["@material-ui/icons/CloudQueueTwoTone" :default CloudQueueTwoTone]
            ["@material-ui/icons/CloudRounded" :default CloudRounded]
            ["@material-ui/icons/CloudSharp" :default CloudSharp]
            ["@material-ui/icons/CloudTwoTone" :default CloudTwoTone]
            ["@material-ui/icons/CloudUpload" :default CloudUpload]
            ["@material-ui/icons/CloudUploadOutlined" :default CloudUploadOutlined]
            ["@material-ui/icons/CloudUploadRounded" :default CloudUploadRounded]
            ["@material-ui/icons/CloudUploadSharp" :default CloudUploadSharp]
            ["@material-ui/icons/CloudUploadTwoTone" :default CloudUploadTwoTone]
            ["@material-ui/icons/Code" :default Code]
            ["@material-ui/icons/CodeOutlined" :default CodeOutlined]
            ["@material-ui/icons/CodeRounded" :default CodeRounded]
            ["@material-ui/icons/CodeSharp" :default CodeSharp]
            ["@material-ui/icons/CodeTwoTone" :default CodeTwoTone]
            ["@material-ui/icons/Collections" :default Collections]
            ["@material-ui/icons/CollectionsBookmark" :default CollectionsBookmark]
            ["@material-ui/icons/CollectionsBookmarkOutlined" :default CollectionsBookmarkOutlined]
            ["@material-ui/icons/CollectionsBookmarkRounded" :default CollectionsBookmarkRounded]
            ["@material-ui/icons/CollectionsBookmarkSharp" :default CollectionsBookmarkSharp]
            ["@material-ui/icons/CollectionsBookmarkTwoTone" :default CollectionsBookmarkTwoTone]
            ["@material-ui/icons/CollectionsOutlined" :default CollectionsOutlined]
            ["@material-ui/icons/CollectionsRounded" :default CollectionsRounded]
            ["@material-ui/icons/CollectionsSharp" :default CollectionsSharp]
            ["@material-ui/icons/CollectionsTwoTone" :default CollectionsTwoTone]
            ["@material-ui/icons/Colorize" :default Colorize]
            ["@material-ui/icons/ColorizeOutlined" :default ColorizeOutlined]
            ["@material-ui/icons/ColorizeRounded" :default ColorizeRounded]
            ["@material-ui/icons/ColorizeSharp" :default ColorizeSharp]
            ["@material-ui/icons/ColorizeTwoTone" :default ColorizeTwoTone]
            ["@material-ui/icons/ColorLens" :default ColorLens]
            ["@material-ui/icons/ColorLensOutlined" :default ColorLensOutlined]
            ["@material-ui/icons/ColorLensRounded" :default ColorLensRounded]
            ["@material-ui/icons/ColorLensSharp" :default ColorLensSharp]
            ["@material-ui/icons/ColorLensTwoTone" :default ColorLensTwoTone]
            ["@material-ui/icons/Comment" :default Comment]
            ["@material-ui/icons/CommentOutlined" :default CommentOutlined]
            ["@material-ui/icons/CommentRounded" :default CommentRounded]
            ["@material-ui/icons/CommentSharp" :default CommentSharp]
            ["@material-ui/icons/CommentTwoTone" :default CommentTwoTone]
            ["@material-ui/icons/Commute" :default Commute]
            ["@material-ui/icons/CommuteOutlined" :default CommuteOutlined]
            ["@material-ui/icons/CommuteRounded" :default CommuteRounded]
            ["@material-ui/icons/CommuteSharp" :default CommuteSharp]
            ["@material-ui/icons/CommuteTwoTone" :default CommuteTwoTone]
            ["@material-ui/icons/Compare" :default Compare]
            ["@material-ui/icons/CompareArrows" :default CompareArrows]
            ["@material-ui/icons/CompareArrowsOutlined" :default CompareArrowsOutlined]
            ["@material-ui/icons/CompareArrowsRounded" :default CompareArrowsRounded]
            ["@material-ui/icons/CompareArrowsSharp" :default CompareArrowsSharp]
            ["@material-ui/icons/CompareArrowsTwoTone" :default CompareArrowsTwoTone]
            ["@material-ui/icons/CompareOutlined" :default CompareOutlined]
            ["@material-ui/icons/CompareRounded" :default CompareRounded]
            ["@material-ui/icons/CompareSharp" :default CompareSharp]
            ["@material-ui/icons/CompareTwoTone" :default CompareTwoTone]
            ["@material-ui/icons/CompassCalibration" :default CompassCalibration]
            ["@material-ui/icons/CompassCalibrationOutlined" :default CompassCalibrationOutlined]
            ["@material-ui/icons/CompassCalibrationRounded" :default CompassCalibrationRounded]
            ["@material-ui/icons/CompassCalibrationSharp" :default CompassCalibrationSharp]
            ["@material-ui/icons/CompassCalibrationTwoTone" :default CompassCalibrationTwoTone]
            ["@material-ui/icons/Computer" :default Computer]
            ["@material-ui/icons/ComputerOutlined" :default ComputerOutlined]
            ["@material-ui/icons/ComputerRounded" :default ComputerRounded]
            ["@material-ui/icons/ComputerSharp" :default ComputerSharp]
            ["@material-ui/icons/ComputerTwoTone" :default ComputerTwoTone]
            ["@material-ui/icons/ConfirmationNumber" :default ConfirmationNumber]
            ["@material-ui/icons/ConfirmationNumberOutlined" :default ConfirmationNumberOutlined]
            ["@material-ui/icons/ConfirmationNumberRounded" :default ConfirmationNumberRounded]
            ["@material-ui/icons/ConfirmationNumberSharp" :default ConfirmationNumberSharp]
            ["@material-ui/icons/ConfirmationNumberTwoTone" :default ConfirmationNumberTwoTone]
            ["@material-ui/icons/Contactless" :default Contactless]
            ["@material-ui/icons/ContactlessOutlined" :default ContactlessOutlined]
            ["@material-ui/icons/ContactlessRounded" :default ContactlessRounded]
            ["@material-ui/icons/ContactlessSharp" :default ContactlessSharp]
            ["@material-ui/icons/ContactlessTwoTone" :default ContactlessTwoTone]
            ["@material-ui/icons/ContactMail" :default ContactMail]
            ["@material-ui/icons/ContactMailOutlined" :default ContactMailOutlined]
            ["@material-ui/icons/ContactMailRounded" :default ContactMailRounded]
            ["@material-ui/icons/ContactMailSharp" :default ContactMailSharp]
            ["@material-ui/icons/ContactMailTwoTone" :default ContactMailTwoTone]
            ["@material-ui/icons/ContactPhone" :default ContactPhone]
            ["@material-ui/icons/ContactPhoneOutlined" :default ContactPhoneOutlined]
            ["@material-ui/icons/ContactPhoneRounded" :default ContactPhoneRounded]
            ["@material-ui/icons/ContactPhoneSharp" :default ContactPhoneSharp]
            ["@material-ui/icons/ContactPhoneTwoTone" :default ContactPhoneTwoTone]
            ["@material-ui/icons/Contacts" :default Contacts]
            ["@material-ui/icons/ContactsOutlined" :default ContactsOutlined]
            ["@material-ui/icons/ContactsRounded" :default ContactsRounded]
            ["@material-ui/icons/ContactsSharp" :default ContactsSharp]
            ["@material-ui/icons/ContactsTwoTone" :default ContactsTwoTone]
            ["@material-ui/icons/ContactSupport" :default ContactSupport]
            ["@material-ui/icons/ContactSupportOutlined" :default ContactSupportOutlined]
            ["@material-ui/icons/ContactSupportRounded" :default ContactSupportRounded]
            ["@material-ui/icons/ContactSupportSharp" :default ContactSupportSharp]
            ["@material-ui/icons/ContactSupportTwoTone" :default ContactSupportTwoTone]
            ["@material-ui/icons/ControlCamera" :default ControlCamera]
            ["@material-ui/icons/ControlCameraOutlined" :default ControlCameraOutlined]
            ["@material-ui/icons/ControlCameraRounded" :default ControlCameraRounded]
            ["@material-ui/icons/ControlCameraSharp" :default ControlCameraSharp]
            ["@material-ui/icons/ControlCameraTwoTone" :default ControlCameraTwoTone]
            ["@material-ui/icons/ControlPoint" :default ControlPoint]
            ["@material-ui/icons/ControlPointDuplicate" :default ControlPointDuplicate]
            ["@material-ui/icons/ControlPointDuplicateOutlined" :default ControlPointDuplicateOutlined]
            ["@material-ui/icons/ControlPointDuplicateRounded" :default ControlPointDuplicateRounded]
            ["@material-ui/icons/ControlPointDuplicateSharp" :default ControlPointDuplicateSharp]
            ["@material-ui/icons/ControlPointDuplicateTwoTone" :default ControlPointDuplicateTwoTone]
            ["@material-ui/icons/ControlPointOutlined" :default ControlPointOutlined]
            ["@material-ui/icons/ControlPointRounded" :default ControlPointRounded]
            ["@material-ui/icons/ControlPointSharp" :default ControlPointSharp]
            ["@material-ui/icons/ControlPointTwoTone" :default ControlPointTwoTone]
            ["@material-ui/icons/Copyright" :default Copyright]
            ["@material-ui/icons/CopyrightOutlined" :default CopyrightOutlined]
            ["@material-ui/icons/CopyrightRounded" :default CopyrightRounded]
            ["@material-ui/icons/CopyrightSharp" :default CopyrightSharp]
            ["@material-ui/icons/CopyrightTwoTone" :default CopyrightTwoTone]
            ["@material-ui/icons/Create" :default Create]
            ["@material-ui/icons/CreateNewFolder" :default CreateNewFolder]
            ["@material-ui/icons/CreateNewFolderOutlined" :default CreateNewFolderOutlined]
            ["@material-ui/icons/CreateNewFolderRounded" :default CreateNewFolderRounded]
            ["@material-ui/icons/CreateNewFolderSharp" :default CreateNewFolderSharp]
            ["@material-ui/icons/CreateNewFolderTwoTone" :default CreateNewFolderTwoTone]
            ["@material-ui/icons/CreateOutlined" :default CreateOutlined]
            ["@material-ui/icons/CreateRounded" :default CreateRounded]
            ["@material-ui/icons/CreateSharp" :default CreateSharp]
            ["@material-ui/icons/CreateTwoTone" :default CreateTwoTone]
            ["@material-ui/icons/CreditCard" :default CreditCard]
            ["@material-ui/icons/CreditCardOutlined" :default CreditCardOutlined]
            ["@material-ui/icons/CreditCardRounded" :default CreditCardRounded]
            ["@material-ui/icons/CreditCardSharp" :default CreditCardSharp]
            ["@material-ui/icons/CreditCardTwoTone" :default CreditCardTwoTone]
            ["@material-ui/icons/Crop" :default Crop]
            ["@material-ui/icons/Crop169" :default Crop169]
            ["@material-ui/icons/Crop169Outlined" :default Crop169Outlined]
            ["@material-ui/icons/Crop169Rounded" :default Crop169Rounded]
            ["@material-ui/icons/Crop169Sharp" :default Crop169Sharp]
            ["@material-ui/icons/Crop169TwoTone" :default Crop169TwoTone]
            ["@material-ui/icons/Crop32" :default Crop32]
            ["@material-ui/icons/Crop32Outlined" :default Crop32Outlined]
            ["@material-ui/icons/Crop32Rounded" :default Crop32Rounded]
            ["@material-ui/icons/Crop32Sharp" :default Crop32Sharp]
            ["@material-ui/icons/Crop32TwoTone" :default Crop32TwoTone]
            ["@material-ui/icons/Crop54" :default Crop54]
            ["@material-ui/icons/Crop54Outlined" :default Crop54Outlined]
            ["@material-ui/icons/Crop54Rounded" :default Crop54Rounded]
            ["@material-ui/icons/Crop54Sharp" :default Crop54Sharp]
            ["@material-ui/icons/Crop54TwoTone" :default Crop54TwoTone]
            ["@material-ui/icons/Crop75" :default Crop75]
            ["@material-ui/icons/Crop75Outlined" :default Crop75Outlined]
            ["@material-ui/icons/Crop75Rounded" :default Crop75Rounded]
            ["@material-ui/icons/Crop75Sharp" :default Crop75Sharp]
            ["@material-ui/icons/Crop75TwoTone" :default Crop75TwoTone]
            ["@material-ui/icons/CropDin" :default CropDin]
            ["@material-ui/icons/CropDinOutlined" :default CropDinOutlined]
            ["@material-ui/icons/CropDinRounded" :default CropDinRounded]
            ["@material-ui/icons/CropDinSharp" :default CropDinSharp]
            ["@material-ui/icons/CropDinTwoTone" :default CropDinTwoTone]
            ["@material-ui/icons/CropFree" :default CropFree]
            ["@material-ui/icons/CropFreeOutlined" :default CropFreeOutlined]
            ["@material-ui/icons/CropFreeRounded" :default CropFreeRounded]
            ["@material-ui/icons/CropFreeSharp" :default CropFreeSharp]
            ["@material-ui/icons/CropFreeTwoTone" :default CropFreeTwoTone]
            ["@material-ui/icons/CropLandscape" :default CropLandscape]
            ["@material-ui/icons/CropLandscapeOutlined" :default CropLandscapeOutlined]
            ["@material-ui/icons/CropLandscapeRounded" :default CropLandscapeRounded]
            ["@material-ui/icons/CropLandscapeSharp" :default CropLandscapeSharp]
            ["@material-ui/icons/CropLandscapeTwoTone" :default CropLandscapeTwoTone]
            ["@material-ui/icons/CropOriginal" :default CropOriginal]
            ["@material-ui/icons/CropOriginalOutlined" :default CropOriginalOutlined]
            ["@material-ui/icons/CropOriginalRounded" :default CropOriginalRounded]
            ["@material-ui/icons/CropOriginalSharp" :default CropOriginalSharp]
            ["@material-ui/icons/CropOriginalTwoTone" :default CropOriginalTwoTone]
            ["@material-ui/icons/CropOutlined" :default CropOutlined]
            ["@material-ui/icons/CropPortrait" :default CropPortrait]
            ["@material-ui/icons/CropPortraitOutlined" :default CropPortraitOutlined]
            ["@material-ui/icons/CropPortraitRounded" :default CropPortraitRounded]
            ["@material-ui/icons/CropPortraitSharp" :default CropPortraitSharp]
            ["@material-ui/icons/CropPortraitTwoTone" :default CropPortraitTwoTone]
            ["@material-ui/icons/CropRotate" :default CropRotate]
            ["@material-ui/icons/CropRotateOutlined" :default CropRotateOutlined]
            ["@material-ui/icons/CropRotateRounded" :default CropRotateRounded]
            ["@material-ui/icons/CropRotateSharp" :default CropRotateSharp]
            ["@material-ui/icons/CropRotateTwoTone" :default CropRotateTwoTone]
            ["@material-ui/icons/CropRounded" :default CropRounded]
            ["@material-ui/icons/CropSharp" :default CropSharp]
            ["@material-ui/icons/CropSquare" :default CropSquare]
            ["@material-ui/icons/CropSquareOutlined" :default CropSquareOutlined]
            ["@material-ui/icons/CropSquareRounded" :default CropSquareRounded]
            ["@material-ui/icons/CropSquareSharp" :default CropSquareSharp]
            ["@material-ui/icons/CropSquareTwoTone" :default CropSquareTwoTone]
            ["@material-ui/icons/CropTwoTone" :default CropTwoTone]
            ["@material-ui/icons/Dashboard" :default Dashboard]
            ["@material-ui/icons/DashboardOutlined" :default DashboardOutlined]
            ["@material-ui/icons/DashboardRounded" :default DashboardRounded]
            ["@material-ui/icons/DashboardSharp" :default DashboardSharp]
            ["@material-ui/icons/DashboardTwoTone" :default DashboardTwoTone]
            ["@material-ui/icons/DataUsage" :default DataUsage]
            ["@material-ui/icons/DataUsageOutlined" :default DataUsageOutlined]
            ["@material-ui/icons/DataUsageRounded" :default DataUsageRounded]
            ["@material-ui/icons/DataUsageSharp" :default DataUsageSharp]
            ["@material-ui/icons/DataUsageTwoTone" :default DataUsageTwoTone]
            ["@material-ui/icons/DateRange" :default DateRange]
            ["@material-ui/icons/DateRangeOutlined" :default DateRangeOutlined]
            ["@material-ui/icons/DateRangeRounded" :default DateRangeRounded]
            ["@material-ui/icons/DateRangeSharp" :default DateRangeSharp]
            ["@material-ui/icons/DateRangeTwoTone" :default DateRangeTwoTone]
            ["@material-ui/icons/Deck" :default Deck]
            ["@material-ui/icons/DeckOutlined" :default DeckOutlined]
            ["@material-ui/icons/DeckRounded" :default DeckRounded]
            ["@material-ui/icons/DeckSharp" :default DeckSharp]
            ["@material-ui/icons/DeckTwoTone" :default DeckTwoTone]
            ["@material-ui/icons/Dehaze" :default Dehaze]
            ["@material-ui/icons/DehazeOutlined" :default DehazeOutlined]
            ["@material-ui/icons/DehazeRounded" :default DehazeRounded]
            ["@material-ui/icons/DehazeSharp" :default DehazeSharp]
            ["@material-ui/icons/DehazeTwoTone" :default DehazeTwoTone]
            ["@material-ui/icons/Delete" :default Delete]
            ["@material-ui/icons/DeleteForever" :default DeleteForever]
            ["@material-ui/icons/DeleteForeverOutlined" :default DeleteForeverOutlined]
            ["@material-ui/icons/DeleteForeverRounded" :default DeleteForeverRounded]
            ["@material-ui/icons/DeleteForeverSharp" :default DeleteForeverSharp]
            ["@material-ui/icons/DeleteForeverTwoTone" :default DeleteForeverTwoTone]
            ["@material-ui/icons/DeleteOutline" :default DeleteOutline]
            ["@material-ui/icons/DeleteOutlined" :default DeleteOutlined]
            ["@material-ui/icons/DeleteOutlineOutlined" :default DeleteOutlineOutlined]
            ["@material-ui/icons/DeleteOutlineRounded" :default DeleteOutlineRounded]
            ["@material-ui/icons/DeleteOutlineSharp" :default DeleteOutlineSharp]
            ["@material-ui/icons/DeleteOutlineTwoTone" :default DeleteOutlineTwoTone]
            ["@material-ui/icons/DeleteRounded" :default DeleteRounded]
            ["@material-ui/icons/DeleteSharp" :default DeleteSharp]
            ["@material-ui/icons/DeleteSweep" :default DeleteSweep]
            ["@material-ui/icons/DeleteSweepOutlined" :default DeleteSweepOutlined]
            ["@material-ui/icons/DeleteSweepRounded" :default DeleteSweepRounded]
            ["@material-ui/icons/DeleteSweepSharp" :default DeleteSweepSharp]
            ["@material-ui/icons/DeleteSweepTwoTone" :default DeleteSweepTwoTone]
            ["@material-ui/icons/DeleteTwoTone" :default DeleteTwoTone]
            ["@material-ui/icons/DepartureBoard" :default DepartureBoard]
            ["@material-ui/icons/DepartureBoardOutlined" :default DepartureBoardOutlined]
            ["@material-ui/icons/DepartureBoardRounded" :default DepartureBoardRounded]
            ["@material-ui/icons/DepartureBoardSharp" :default DepartureBoardSharp]
            ["@material-ui/icons/DepartureBoardTwoTone" :default DepartureBoardTwoTone]
            ["@material-ui/icons/Description" :default Description]
            ["@material-ui/icons/DescriptionOutlined" :default DescriptionOutlined]
            ["@material-ui/icons/DescriptionRounded" :default DescriptionRounded]
            ["@material-ui/icons/DescriptionSharp" :default DescriptionSharp]
            ["@material-ui/icons/DescriptionTwoTone" :default DescriptionTwoTone]
            ["@material-ui/icons/DesktopAccessDisabled" :default DesktopAccessDisabled]
            ["@material-ui/icons/DesktopAccessDisabledOutlined" :default DesktopAccessDisabledOutlined]
            ["@material-ui/icons/DesktopAccessDisabledRounded" :default DesktopAccessDisabledRounded]
            ["@material-ui/icons/DesktopAccessDisabledSharp" :default DesktopAccessDisabledSharp]
            ["@material-ui/icons/DesktopAccessDisabledTwoTone" :default DesktopAccessDisabledTwoTone]
            ["@material-ui/icons/DesktopMac" :default DesktopMac]
            ["@material-ui/icons/DesktopMacOutlined" :default DesktopMacOutlined]
            ["@material-ui/icons/DesktopMacRounded" :default DesktopMacRounded]
            ["@material-ui/icons/DesktopMacSharp" :default DesktopMacSharp]
            ["@material-ui/icons/DesktopMacTwoTone" :default DesktopMacTwoTone]
            ["@material-ui/icons/DesktopWindows" :default DesktopWindows]
            ["@material-ui/icons/DesktopWindowsOutlined" :default DesktopWindowsOutlined]
            ["@material-ui/icons/DesktopWindowsRounded" :default DesktopWindowsRounded]
            ["@material-ui/icons/DesktopWindowsSharp" :default DesktopWindowsSharp]
            ["@material-ui/icons/DesktopWindowsTwoTone" :default DesktopWindowsTwoTone]
            ["@material-ui/icons/Details" :default Details]
            ["@material-ui/icons/DetailsOutlined" :default DetailsOutlined]
            ["@material-ui/icons/DetailsRounded" :default DetailsRounded]
            ["@material-ui/icons/DetailsSharp" :default DetailsSharp]
            ["@material-ui/icons/DetailsTwoTone" :default DetailsTwoTone]
            ["@material-ui/icons/DeveloperBoard" :default DeveloperBoard]
            ["@material-ui/icons/DeveloperBoardOutlined" :default DeveloperBoardOutlined]
            ["@material-ui/icons/DeveloperBoardRounded" :default DeveloperBoardRounded]
            ["@material-ui/icons/DeveloperBoardSharp" :default DeveloperBoardSharp]
            ["@material-ui/icons/DeveloperBoardTwoTone" :default DeveloperBoardTwoTone]
            ["@material-ui/icons/DeveloperMode" :default DeveloperMode]
            ["@material-ui/icons/DeveloperModeOutlined" :default DeveloperModeOutlined]
            ["@material-ui/icons/DeveloperModeRounded" :default DeveloperModeRounded]
            ["@material-ui/icons/DeveloperModeSharp" :default DeveloperModeSharp]
            ["@material-ui/icons/DeveloperModeTwoTone" :default DeveloperModeTwoTone]
            ["@material-ui/icons/DeviceHub" :default DeviceHub]
            ["@material-ui/icons/DeviceHubOutlined" :default DeviceHubOutlined]
            ["@material-ui/icons/DeviceHubRounded" :default DeviceHubRounded]
            ["@material-ui/icons/DeviceHubSharp" :default DeviceHubSharp]
            ["@material-ui/icons/DeviceHubTwoTone" :default DeviceHubTwoTone]
            ["@material-ui/icons/Devices" :default Devices]
            ["@material-ui/icons/DevicesOther" :default DevicesOther]
            ["@material-ui/icons/DevicesOtherOutlined" :default DevicesOtherOutlined]
            ["@material-ui/icons/DevicesOtherRounded" :default DevicesOtherRounded]
            ["@material-ui/icons/DevicesOtherSharp" :default DevicesOtherSharp]
            ["@material-ui/icons/DevicesOtherTwoTone" :default DevicesOtherTwoTone]
            ["@material-ui/icons/DevicesOutlined" :default DevicesOutlined]
            ["@material-ui/icons/DevicesRounded" :default DevicesRounded]
            ["@material-ui/icons/DevicesSharp" :default DevicesSharp]
            ["@material-ui/icons/DevicesTwoTone" :default DevicesTwoTone]
            ["@material-ui/icons/DeviceUnknown" :default DeviceUnknown]
            ["@material-ui/icons/DeviceUnknownOutlined" :default DeviceUnknownOutlined]
            ["@material-ui/icons/DeviceUnknownRounded" :default DeviceUnknownRounded]
            ["@material-ui/icons/DeviceUnknownSharp" :default DeviceUnknownSharp]
            ["@material-ui/icons/DeviceUnknownTwoTone" :default DeviceUnknownTwoTone]
            ["@material-ui/icons/DialerSip" :default DialerSip]
            ["@material-ui/icons/DialerSipOutlined" :default DialerSipOutlined]
            ["@material-ui/icons/DialerSipRounded" :default DialerSipRounded]
            ["@material-ui/icons/DialerSipSharp" :default DialerSipSharp]
            ["@material-ui/icons/DialerSipTwoTone" :default DialerSipTwoTone]
            ["@material-ui/icons/Dialpad" :default Dialpad]
            ["@material-ui/icons/DialpadOutlined" :default DialpadOutlined]
            ["@material-ui/icons/DialpadRounded" :default DialpadRounded]
            ["@material-ui/icons/DialpadSharp" :default DialpadSharp]
            ["@material-ui/icons/DialpadTwoTone" :default DialpadTwoTone]
            ["@material-ui/icons/Directions" :default Directions]
            ["@material-ui/icons/DirectionsBike" :default DirectionsBike]
            ["@material-ui/icons/DirectionsBikeOutlined" :default DirectionsBikeOutlined]
            ["@material-ui/icons/DirectionsBikeRounded" :default DirectionsBikeRounded]
            ["@material-ui/icons/DirectionsBikeSharp" :default DirectionsBikeSharp]
            ["@material-ui/icons/DirectionsBikeTwoTone" :default DirectionsBikeTwoTone]
            ["@material-ui/icons/DirectionsBoat" :default DirectionsBoat]
            ["@material-ui/icons/DirectionsBoatOutlined" :default DirectionsBoatOutlined]
            ["@material-ui/icons/DirectionsBoatRounded" :default DirectionsBoatRounded]
            ["@material-ui/icons/DirectionsBoatSharp" :default DirectionsBoatSharp]
            ["@material-ui/icons/DirectionsBoatTwoTone" :default DirectionsBoatTwoTone]
            ["@material-ui/icons/DirectionsBus" :default DirectionsBus]
            ["@material-ui/icons/DirectionsBusOutlined" :default DirectionsBusOutlined]
            ["@material-ui/icons/DirectionsBusRounded" :default DirectionsBusRounded]
            ["@material-ui/icons/DirectionsBusSharp" :default DirectionsBusSharp]
            ["@material-ui/icons/DirectionsBusTwoTone" :default DirectionsBusTwoTone]
            ["@material-ui/icons/DirectionsCar" :default DirectionsCar]
            ["@material-ui/icons/DirectionsCarOutlined" :default DirectionsCarOutlined]
            ["@material-ui/icons/DirectionsCarRounded" :default DirectionsCarRounded]
            ["@material-ui/icons/DirectionsCarSharp" :default DirectionsCarSharp]
            ["@material-ui/icons/DirectionsCarTwoTone" :default DirectionsCarTwoTone]
            ["@material-ui/icons/DirectionsOutlined" :default DirectionsOutlined]
            ["@material-ui/icons/DirectionsRailway" :default DirectionsRailway]
            ["@material-ui/icons/DirectionsRailwayOutlined" :default DirectionsRailwayOutlined]
            ["@material-ui/icons/DirectionsRailwayRounded" :default DirectionsRailwayRounded]
            ["@material-ui/icons/DirectionsRailwaySharp" :default DirectionsRailwaySharp]
            ["@material-ui/icons/DirectionsRailwayTwoTone" :default DirectionsRailwayTwoTone]
            ["@material-ui/icons/DirectionsRounded" :default DirectionsRounded]
            ["@material-ui/icons/DirectionsRun" :default DirectionsRun]
            ["@material-ui/icons/DirectionsRunOutlined" :default DirectionsRunOutlined]
            ["@material-ui/icons/DirectionsRunRounded" :default DirectionsRunRounded]
            ["@material-ui/icons/DirectionsRunSharp" :default DirectionsRunSharp]
            ["@material-ui/icons/DirectionsRunTwoTone" :default DirectionsRunTwoTone]
            ["@material-ui/icons/DirectionsSharp" :default DirectionsSharp]
            ["@material-ui/icons/DirectionsSubway" :default DirectionsSubway]
            ["@material-ui/icons/DirectionsSubwayOutlined" :default DirectionsSubwayOutlined]
            ["@material-ui/icons/DirectionsSubwayRounded" :default DirectionsSubwayRounded]
            ["@material-ui/icons/DirectionsSubwaySharp" :default DirectionsSubwaySharp]
            ["@material-ui/icons/DirectionsSubwayTwoTone" :default DirectionsSubwayTwoTone]
            ["@material-ui/icons/DirectionsTransit" :default DirectionsTransit]
            ["@material-ui/icons/DirectionsTransitOutlined" :default DirectionsTransitOutlined]
            ["@material-ui/icons/DirectionsTransitRounded" :default DirectionsTransitRounded]
            ["@material-ui/icons/DirectionsTransitSharp" :default DirectionsTransitSharp]
            ["@material-ui/icons/DirectionsTransitTwoTone" :default DirectionsTransitTwoTone]
            ["@material-ui/icons/DirectionsTwoTone" :default DirectionsTwoTone]
            ["@material-ui/icons/DirectionsWalk" :default DirectionsWalk]
            ["@material-ui/icons/DirectionsWalkOutlined" :default DirectionsWalkOutlined]
            ["@material-ui/icons/DirectionsWalkRounded" :default DirectionsWalkRounded]
            ["@material-ui/icons/DirectionsWalkSharp" :default DirectionsWalkSharp]
            ["@material-ui/icons/DirectionsWalkTwoTone" :default DirectionsWalkTwoTone]
            ["@material-ui/icons/DiscFull" :default DiscFull]
            ["@material-ui/icons/DiscFullOutlined" :default DiscFullOutlined]
            ["@material-ui/icons/DiscFullRounded" :default DiscFullRounded]
            ["@material-ui/icons/DiscFullSharp" :default DiscFullSharp]
            ["@material-ui/icons/DiscFullTwoTone" :default DiscFullTwoTone]
            ["@material-ui/icons/Dns" :default Dns]
            ["@material-ui/icons/DnsOutlined" :default DnsOutlined]
            ["@material-ui/icons/DnsRounded" :default DnsRounded]
            ["@material-ui/icons/DnsSharp" :default DnsSharp]
            ["@material-ui/icons/DnsTwoTone" :default DnsTwoTone]
            ["@material-ui/icons/Dock" :default Dock]
            ["@material-ui/icons/DockOutlined" :default DockOutlined]
            ["@material-ui/icons/DockRounded" :default DockRounded]
            ["@material-ui/icons/DockSharp" :default DockSharp]
            ["@material-ui/icons/DockTwoTone" :default DockTwoTone]
            ["@material-ui/icons/Domain" :default Domain]
            ["@material-ui/icons/DomainDisabled" :default DomainDisabled]
            ["@material-ui/icons/DomainDisabledOutlined" :default DomainDisabledOutlined]
            ["@material-ui/icons/DomainDisabledRounded" :default DomainDisabledRounded]
            ["@material-ui/icons/DomainDisabledSharp" :default DomainDisabledSharp]
            ["@material-ui/icons/DomainDisabledTwoTone" :default DomainDisabledTwoTone]
            ["@material-ui/icons/DomainOutlined" :default DomainOutlined]
            ["@material-ui/icons/DomainRounded" :default DomainRounded]
            ["@material-ui/icons/DomainSharp" :default DomainSharp]
            ["@material-ui/icons/DomainTwoTone" :default DomainTwoTone]
            ["@material-ui/icons/Done" :default Done]
            ["@material-ui/icons/DoneAll" :default DoneAll]
            ["@material-ui/icons/DoneAllOutlined" :default DoneAllOutlined]
            ["@material-ui/icons/DoneAllRounded" :default DoneAllRounded]
            ["@material-ui/icons/DoneAllSharp" :default DoneAllSharp]
            ["@material-ui/icons/DoneAllTwoTone" :default DoneAllTwoTone]
            ["@material-ui/icons/DoneOutline" :default DoneOutline]
            ["@material-ui/icons/DoneOutlined" :default DoneOutlined]
            ["@material-ui/icons/DoneOutlineOutlined" :default DoneOutlineOutlined]
            ["@material-ui/icons/DoneOutlineRounded" :default DoneOutlineRounded]
            ["@material-ui/icons/DoneOutlineSharp" :default DoneOutlineSharp]
            ["@material-ui/icons/DoneOutlineTwoTone" :default DoneOutlineTwoTone]
            ["@material-ui/icons/DoneRounded" :default DoneRounded]
            ["@material-ui/icons/DoneSharp" :default DoneSharp]
            ["@material-ui/icons/DoneTwoTone" :default DoneTwoTone]
            ["@material-ui/icons/DonutLarge" :default DonutLarge]
            ["@material-ui/icons/DonutLargeOutlined" :default DonutLargeOutlined]
            ["@material-ui/icons/DonutLargeRounded" :default DonutLargeRounded]
            ["@material-ui/icons/DonutLargeSharp" :default DonutLargeSharp]
            ["@material-ui/icons/DonutLargeTwoTone" :default DonutLargeTwoTone]
            ["@material-ui/icons/DonutSmall" :default DonutSmall]
            ["@material-ui/icons/DonutSmallOutlined" :default DonutSmallOutlined]
            ["@material-ui/icons/DonutSmallRounded" :default DonutSmallRounded]
            ["@material-ui/icons/DonutSmallSharp" :default DonutSmallSharp]
            ["@material-ui/icons/DonutSmallTwoTone" :default DonutSmallTwoTone]
            ["@material-ui/icons/DoubleArrow" :default DoubleArrow]
            ["@material-ui/icons/DoubleArrowOutlined" :default DoubleArrowOutlined]
            ["@material-ui/icons/DoubleArrowRounded" :default DoubleArrowRounded]
            ["@material-ui/icons/DoubleArrowSharp" :default DoubleArrowSharp]
            ["@material-ui/icons/DoubleArrowTwoTone" :default DoubleArrowTwoTone]
            ["@material-ui/icons/Drafts" :default Drafts]
            ["@material-ui/icons/DraftsOutlined" :default DraftsOutlined]
            ["@material-ui/icons/DraftsRounded" :default DraftsRounded]
            ["@material-ui/icons/DraftsSharp" :default DraftsSharp]
            ["@material-ui/icons/DraftsTwoTone" :default DraftsTwoTone]
            ["@material-ui/icons/DragHandle" :default DragHandle]
            ["@material-ui/icons/DragHandleOutlined" :default DragHandleOutlined]
            ["@material-ui/icons/DragHandleRounded" :default DragHandleRounded]
            ["@material-ui/icons/DragHandleSharp" :default DragHandleSharp]
            ["@material-ui/icons/DragHandleTwoTone" :default DragHandleTwoTone]
            ["@material-ui/icons/DragIndicator" :default DragIndicator]
            ["@material-ui/icons/DragIndicatorOutlined" :default DragIndicatorOutlined]
            ["@material-ui/icons/DragIndicatorRounded" :default DragIndicatorRounded]
            ["@material-ui/icons/DragIndicatorSharp" :default DragIndicatorSharp]
            ["@material-ui/icons/DragIndicatorTwoTone" :default DragIndicatorTwoTone]
            ["@material-ui/icons/DriveEta" :default DriveEta]
            ["@material-ui/icons/DriveEtaOutlined" :default DriveEtaOutlined]
            ["@material-ui/icons/DriveEtaRounded" :default DriveEtaRounded]
            ["@material-ui/icons/DriveEtaSharp" :default DriveEtaSharp]
            ["@material-ui/icons/DriveEtaTwoTone" :default DriveEtaTwoTone]
            ["@material-ui/icons/Duo" :default Duo]
            ["@material-ui/icons/DuoOutlined" :default DuoOutlined]
            ["@material-ui/icons/DuoRounded" :default DuoRounded]
            ["@material-ui/icons/DuoSharp" :default DuoSharp]
            ["@material-ui/icons/DuoTwoTone" :default DuoTwoTone]
            ["@material-ui/icons/Dvr" :default Dvr]
            ["@material-ui/icons/DvrOutlined" :default DvrOutlined]
            ["@material-ui/icons/DvrRounded" :default DvrRounded]
            ["@material-ui/icons/DvrSharp" :default DvrSharp]
            ["@material-ui/icons/DvrTwoTone" :default DvrTwoTone]
            ["@material-ui/icons/DynamicFeed" :default DynamicFeed]
            ["@material-ui/icons/DynamicFeedOutlined" :default DynamicFeedOutlined]
            ["@material-ui/icons/DynamicFeedRounded" :default DynamicFeedRounded]
            ["@material-ui/icons/DynamicFeedSharp" :default DynamicFeedSharp]
            ["@material-ui/icons/DynamicFeedTwoTone" :default DynamicFeedTwoTone]
            ["@material-ui/icons/Eco" :default Eco]
            ["@material-ui/icons/EcoOutlined" :default EcoOutlined]
            ["@material-ui/icons/EcoRounded" :default EcoRounded]
            ["@material-ui/icons/EcoSharp" :default EcoSharp]
            ["@material-ui/icons/EcoTwoTone" :default EcoTwoTone]
            ["@material-ui/icons/Edit" :default Edit]
            ["@material-ui/icons/EditAttributes" :default EditAttributes]
            ["@material-ui/icons/EditAttributesOutlined" :default EditAttributesOutlined]
            ["@material-ui/icons/EditAttributesRounded" :default EditAttributesRounded]
            ["@material-ui/icons/EditAttributesSharp" :default EditAttributesSharp]
            ["@material-ui/icons/EditAttributesTwoTone" :default EditAttributesTwoTone]
            ["@material-ui/icons/EditLocation" :default EditLocation]
            ["@material-ui/icons/EditLocationOutlined" :default EditLocationOutlined]
            ["@material-ui/icons/EditLocationRounded" :default EditLocationRounded]
            ["@material-ui/icons/EditLocationSharp" :default EditLocationSharp]
            ["@material-ui/icons/EditLocationTwoTone" :default EditLocationTwoTone]
            ["@material-ui/icons/EditOutlined" :default EditOutlined]
            ["@material-ui/icons/EditRounded" :default EditRounded]
            ["@material-ui/icons/EditSharp" :default EditSharp]
            ["@material-ui/icons/EditTwoTone" :default EditTwoTone]
            ["@material-ui/icons/Eject" :default Eject]
            ["@material-ui/icons/EjectOutlined" :default EjectOutlined]
            ["@material-ui/icons/EjectRounded" :default EjectRounded]
            ["@material-ui/icons/EjectSharp" :default EjectSharp]
            ["@material-ui/icons/EjectTwoTone" :default EjectTwoTone]
            ["@material-ui/icons/Email" :default Email]
            ["@material-ui/icons/EmailOutlined" :default EmailOutlined]
            ["@material-ui/icons/EmailRounded" :default EmailRounded]
            ["@material-ui/icons/EmailSharp" :default EmailSharp]
            ["@material-ui/icons/EmailTwoTone" :default EmailTwoTone]
            ["@material-ui/icons/EmojiEmotions" :default EmojiEmotions]
            ["@material-ui/icons/EmojiEmotionsOutlined" :default EmojiEmotionsOutlined]
            ["@material-ui/icons/EmojiEmotionsRounded" :default EmojiEmotionsRounded]
            ["@material-ui/icons/EmojiEmotionsSharp" :default EmojiEmotionsSharp]
            ["@material-ui/icons/EmojiEmotionsTwoTone" :default EmojiEmotionsTwoTone]
            ["@material-ui/icons/EmojiEvents" :default EmojiEvents]
            ["@material-ui/icons/EmojiEventsOutlined" :default EmojiEventsOutlined]
            ["@material-ui/icons/EmojiEventsRounded" :default EmojiEventsRounded]
            ["@material-ui/icons/EmojiEventsSharp" :default EmojiEventsSharp]
            ["@material-ui/icons/EmojiEventsTwoTone" :default EmojiEventsTwoTone]
            ["@material-ui/icons/EmojiFlags" :default EmojiFlags]
            ["@material-ui/icons/EmojiFlagsOutlined" :default EmojiFlagsOutlined]
            ["@material-ui/icons/EmojiFlagsRounded" :default EmojiFlagsRounded]
            ["@material-ui/icons/EmojiFlagsSharp" :default EmojiFlagsSharp]
            ["@material-ui/icons/EmojiFlagsTwoTone" :default EmojiFlagsTwoTone]
            ["@material-ui/icons/EmojiFoodBeverage" :default EmojiFoodBeverage]
            ["@material-ui/icons/EmojiFoodBeverageOutlined" :default EmojiFoodBeverageOutlined]
            ["@material-ui/icons/EmojiFoodBeverageRounded" :default EmojiFoodBeverageRounded]
            ["@material-ui/icons/EmojiFoodBeverageSharp" :default EmojiFoodBeverageSharp]
            ["@material-ui/icons/EmojiFoodBeverageTwoTone" :default EmojiFoodBeverageTwoTone]
            ["@material-ui/icons/EmojiNature" :default EmojiNature]
            ["@material-ui/icons/EmojiNatureOutlined" :default EmojiNatureOutlined]
            ["@material-ui/icons/EmojiNatureRounded" :default EmojiNatureRounded]
            ["@material-ui/icons/EmojiNatureSharp" :default EmojiNatureSharp]
            ["@material-ui/icons/EmojiNatureTwoTone" :default EmojiNatureTwoTone]
            ["@material-ui/icons/EmojiObjects" :default EmojiObjects]
            ["@material-ui/icons/EmojiObjectsOutlined" :default EmojiObjectsOutlined]
            ["@material-ui/icons/EmojiObjectsRounded" :default EmojiObjectsRounded]
            ["@material-ui/icons/EmojiObjectsSharp" :default EmojiObjectsSharp]
            ["@material-ui/icons/EmojiObjectsTwoTone" :default EmojiObjectsTwoTone]
            ["@material-ui/icons/EmojiPeople" :default EmojiPeople]
            ["@material-ui/icons/EmojiPeopleOutlined" :default EmojiPeopleOutlined]
            ["@material-ui/icons/EmojiPeopleRounded" :default EmojiPeopleRounded]
            ["@material-ui/icons/EmojiPeopleSharp" :default EmojiPeopleSharp]
            ["@material-ui/icons/EmojiPeopleTwoTone" :default EmojiPeopleTwoTone]
            ["@material-ui/icons/EmojiSymbols" :default EmojiSymbols]
            ["@material-ui/icons/EmojiSymbolsOutlined" :default EmojiSymbolsOutlined]
            ["@material-ui/icons/EmojiSymbolsRounded" :default EmojiSymbolsRounded]
            ["@material-ui/icons/EmojiSymbolsSharp" :default EmojiSymbolsSharp]
            ["@material-ui/icons/EmojiSymbolsTwoTone" :default EmojiSymbolsTwoTone]
            ["@material-ui/icons/EmojiTransportation" :default EmojiTransportation]
            ["@material-ui/icons/EmojiTransportationOutlined" :default EmojiTransportationOutlined]
            ["@material-ui/icons/EmojiTransportationRounded" :default EmojiTransportationRounded]
            ["@material-ui/icons/EmojiTransportationSharp" :default EmojiTransportationSharp]
            ["@material-ui/icons/EmojiTransportationTwoTone" :default EmojiTransportationTwoTone]
            ["@material-ui/icons/EnhancedEncryption" :default EnhancedEncryption]
            ["@material-ui/icons/EnhancedEncryptionOutlined" :default EnhancedEncryptionOutlined]
            ["@material-ui/icons/EnhancedEncryptionRounded" :default EnhancedEncryptionRounded]
            ["@material-ui/icons/EnhancedEncryptionSharp" :default EnhancedEncryptionSharp]
            ["@material-ui/icons/EnhancedEncryptionTwoTone" :default EnhancedEncryptionTwoTone]
            ["@material-ui/icons/Equalizer" :default Equalizer]
            ["@material-ui/icons/EqualizerOutlined" :default EqualizerOutlined]
            ["@material-ui/icons/EqualizerRounded" :default EqualizerRounded]
            ["@material-ui/icons/EqualizerSharp" :default EqualizerSharp]
            ["@material-ui/icons/EqualizerTwoTone" :default EqualizerTwoTone]
            ["@material-ui/icons/Error" :default Error]
            ["@material-ui/icons/ErrorOutline" :default ErrorOutline]
            ["@material-ui/icons/ErrorOutlined" :default ErrorOutlined]
            ["@material-ui/icons/ErrorOutlineOutlined" :default ErrorOutlineOutlined]
            ["@material-ui/icons/ErrorOutlineRounded" :default ErrorOutlineRounded]
            ["@material-ui/icons/ErrorOutlineSharp" :default ErrorOutlineSharp]
            ["@material-ui/icons/ErrorOutlineTwoTone" :default ErrorOutlineTwoTone]
            ["@material-ui/icons/ErrorRounded" :default ErrorRounded]
            ["@material-ui/icons/ErrorSharp" :default ErrorSharp]
            ["@material-ui/icons/ErrorTwoTone" :default ErrorTwoTone]
            ["@material-ui/icons/Euro" :default Euro]
            ["@material-ui/icons/EuroOutlined" :default EuroOutlined]
            ["@material-ui/icons/EuroRounded" :default EuroRounded]
            ["@material-ui/icons/EuroSharp" :default EuroSharp]
            ["@material-ui/icons/EuroSymbol" :default EuroSymbol]
            ["@material-ui/icons/EuroSymbolOutlined" :default EuroSymbolOutlined]
            ["@material-ui/icons/EuroSymbolRounded" :default EuroSymbolRounded]
            ["@material-ui/icons/EuroSymbolSharp" :default EuroSymbolSharp]
            ["@material-ui/icons/EuroSymbolTwoTone" :default EuroSymbolTwoTone]
            ["@material-ui/icons/EuroTwoTone" :default EuroTwoTone]
            ["@material-ui/icons/Event" :default Event]
            ["@material-ui/icons/EventAvailable" :default EventAvailable]
            ["@material-ui/icons/EventAvailableOutlined" :default EventAvailableOutlined]
            ["@material-ui/icons/EventAvailableRounded" :default EventAvailableRounded]
            ["@material-ui/icons/EventAvailableSharp" :default EventAvailableSharp]
            ["@material-ui/icons/EventAvailableTwoTone" :default EventAvailableTwoTone]
            ["@material-ui/icons/EventBusy" :default EventBusy]
            ["@material-ui/icons/EventBusyOutlined" :default EventBusyOutlined]
            ["@material-ui/icons/EventBusyRounded" :default EventBusyRounded]
            ["@material-ui/icons/EventBusySharp" :default EventBusySharp]
            ["@material-ui/icons/EventBusyTwoTone" :default EventBusyTwoTone]
            ["@material-ui/icons/EventNote" :default EventNote]
            ["@material-ui/icons/EventNoteOutlined" :default EventNoteOutlined]
            ["@material-ui/icons/EventNoteRounded" :default EventNoteRounded]
            ["@material-ui/icons/EventNoteSharp" :default EventNoteSharp]
            ["@material-ui/icons/EventNoteTwoTone" :default EventNoteTwoTone]
            ["@material-ui/icons/EventOutlined" :default EventOutlined]
            ["@material-ui/icons/EventRounded" :default EventRounded]
            ["@material-ui/icons/EventSeat" :default EventSeat]
            ["@material-ui/icons/EventSeatOutlined" :default EventSeatOutlined]
            ["@material-ui/icons/EventSeatRounded" :default EventSeatRounded]
            ["@material-ui/icons/EventSeatSharp" :default EventSeatSharp]
            ["@material-ui/icons/EventSeatTwoTone" :default EventSeatTwoTone]
            ["@material-ui/icons/EventSharp" :default EventSharp]
            ["@material-ui/icons/EventTwoTone" :default EventTwoTone]
            ["@material-ui/icons/EvStation" :default EvStation]
            ["@material-ui/icons/EvStationOutlined" :default EvStationOutlined]
            ["@material-ui/icons/EvStationRounded" :default EvStationRounded]
            ["@material-ui/icons/EvStationSharp" :default EvStationSharp]
            ["@material-ui/icons/EvStationTwoTone" :default EvStationTwoTone]
            ["@material-ui/icons/ExitToApp" :default ExitToApp]
            ["@material-ui/icons/ExitToAppOutlined" :default ExitToAppOutlined]
            ["@material-ui/icons/ExitToAppRounded" :default ExitToAppRounded]
            ["@material-ui/icons/ExitToAppSharp" :default ExitToAppSharp]
            ["@material-ui/icons/ExitToAppTwoTone" :default ExitToAppTwoTone]
            ["@material-ui/icons/ExpandLess" :default ExpandLess]
            ["@material-ui/icons/ExpandLessOutlined" :default ExpandLessOutlined]
            ["@material-ui/icons/ExpandLessRounded" :default ExpandLessRounded]
            ["@material-ui/icons/ExpandLessSharp" :default ExpandLessSharp]
            ["@material-ui/icons/ExpandLessTwoTone" :default ExpandLessTwoTone]
            ["@material-ui/icons/ExpandMore" :default ExpandMore]
            ["@material-ui/icons/ExpandMoreOutlined" :default ExpandMoreOutlined]
            ["@material-ui/icons/ExpandMoreRounded" :default ExpandMoreRounded]
            ["@material-ui/icons/ExpandMoreSharp" :default ExpandMoreSharp]
            ["@material-ui/icons/ExpandMoreTwoTone" :default ExpandMoreTwoTone]
            ["@material-ui/icons/Explicit" :default Explicit]
            ["@material-ui/icons/ExplicitOutlined" :default ExplicitOutlined]
            ["@material-ui/icons/ExplicitRounded" :default ExplicitRounded]
            ["@material-ui/icons/ExplicitSharp" :default ExplicitSharp]
            ["@material-ui/icons/ExplicitTwoTone" :default ExplicitTwoTone]
            ["@material-ui/icons/Explore" :default Explore]
            ["@material-ui/icons/ExploreOff" :default ExploreOff]
            ["@material-ui/icons/ExploreOffOutlined" :default ExploreOffOutlined]
            ["@material-ui/icons/ExploreOffRounded" :default ExploreOffRounded]
            ["@material-ui/icons/ExploreOffSharp" :default ExploreOffSharp]
            ["@material-ui/icons/ExploreOffTwoTone" :default ExploreOffTwoTone]
            ["@material-ui/icons/ExploreOutlined" :default ExploreOutlined]
            ["@material-ui/icons/ExploreRounded" :default ExploreRounded]
            ["@material-ui/icons/ExploreSharp" :default ExploreSharp]
            ["@material-ui/icons/ExploreTwoTone" :default ExploreTwoTone]
            ["@material-ui/icons/Exposure" :default Exposure]
            ["@material-ui/icons/ExposureNeg1" :default ExposureNeg1]
            ["@material-ui/icons/ExposureNeg1Outlined" :default ExposureNeg1Outlined]
            ["@material-ui/icons/ExposureNeg1Rounded" :default ExposureNeg1Rounded]
            ["@material-ui/icons/ExposureNeg1Sharp" :default ExposureNeg1Sharp]
            ["@material-ui/icons/ExposureNeg1TwoTone" :default ExposureNeg1TwoTone]
            ["@material-ui/icons/ExposureNeg2" :default ExposureNeg2]
            ["@material-ui/icons/ExposureNeg2Outlined" :default ExposureNeg2Outlined]
            ["@material-ui/icons/ExposureNeg2Rounded" :default ExposureNeg2Rounded]
            ["@material-ui/icons/ExposureNeg2Sharp" :default ExposureNeg2Sharp]
            ["@material-ui/icons/ExposureNeg2TwoTone" :default ExposureNeg2TwoTone]
            ["@material-ui/icons/ExposureOutlined" :default ExposureOutlined]
            ["@material-ui/icons/ExposurePlus1" :default ExposurePlus1]
            ["@material-ui/icons/ExposurePlus1Outlined" :default ExposurePlus1Outlined]
            ["@material-ui/icons/ExposurePlus1Rounded" :default ExposurePlus1Rounded]
            ["@material-ui/icons/ExposurePlus1Sharp" :default ExposurePlus1Sharp]
            ["@material-ui/icons/ExposurePlus1TwoTone" :default ExposurePlus1TwoTone]
            ["@material-ui/icons/ExposurePlus2" :default ExposurePlus2]
            ["@material-ui/icons/ExposurePlus2Outlined" :default ExposurePlus2Outlined]
            ["@material-ui/icons/ExposurePlus2Rounded" :default ExposurePlus2Rounded]
            ["@material-ui/icons/ExposurePlus2Sharp" :default ExposurePlus2Sharp]
            ["@material-ui/icons/ExposurePlus2TwoTone" :default ExposurePlus2TwoTone]
            ["@material-ui/icons/ExposureRounded" :default ExposureRounded]
            ["@material-ui/icons/ExposureSharp" :default ExposureSharp]
            ["@material-ui/icons/ExposureTwoTone" :default ExposureTwoTone]
            ["@material-ui/icons/ExposureZero" :default ExposureZero]
            ["@material-ui/icons/ExposureZeroOutlined" :default ExposureZeroOutlined]
            ["@material-ui/icons/ExposureZeroRounded" :default ExposureZeroRounded]
            ["@material-ui/icons/ExposureZeroSharp" :default ExposureZeroSharp]
            ["@material-ui/icons/ExposureZeroTwoTone" :default ExposureZeroTwoTone]
            ["@material-ui/icons/Extension" :default Extension]
            ["@material-ui/icons/ExtensionOutlined" :default ExtensionOutlined]
            ["@material-ui/icons/ExtensionRounded" :default ExtensionRounded]
            ["@material-ui/icons/ExtensionSharp" :default ExtensionSharp]
            ["@material-ui/icons/ExtensionTwoTone" :default ExtensionTwoTone]
            ["@material-ui/icons/Face" :default Face]
            ["@material-ui/icons/Facebook" :default Facebook]
            ["@material-ui/icons/FaceOutlined" :default FaceOutlined]
            ["@material-ui/icons/FaceRounded" :default FaceRounded]
            ["@material-ui/icons/FaceSharp" :default FaceSharp]
            ["@material-ui/icons/FaceTwoTone" :default FaceTwoTone]
            ["@material-ui/icons/Fastfood" :default Fastfood]
            ["@material-ui/icons/FastfoodOutlined" :default FastfoodOutlined]
            ["@material-ui/icons/FastfoodRounded" :default FastfoodRounded]
            ["@material-ui/icons/FastfoodSharp" :default FastfoodSharp]
            ["@material-ui/icons/FastfoodTwoTone" :default FastfoodTwoTone]
            ["@material-ui/icons/FastForward" :default FastForward]
            ["@material-ui/icons/FastForwardOutlined" :default FastForwardOutlined]
            ["@material-ui/icons/FastForwardRounded" :default FastForwardRounded]
            ["@material-ui/icons/FastForwardSharp" :default FastForwardSharp]
            ["@material-ui/icons/FastForwardTwoTone" :default FastForwardTwoTone]
            ["@material-ui/icons/FastRewind" :default FastRewind]
            ["@material-ui/icons/FastRewindOutlined" :default FastRewindOutlined]
            ["@material-ui/icons/FastRewindRounded" :default FastRewindRounded]
            ["@material-ui/icons/FastRewindSharp" :default FastRewindSharp]
            ["@material-ui/icons/FastRewindTwoTone" :default FastRewindTwoTone]
            ["@material-ui/icons/Favorite" :default Favorite]
            ["@material-ui/icons/FavoriteBorder" :default FavoriteBorder]
            ["@material-ui/icons/FavoriteBorderOutlined" :default FavoriteBorderOutlined]
            ["@material-ui/icons/FavoriteBorderRounded" :default FavoriteBorderRounded]
            ["@material-ui/icons/FavoriteBorderSharp" :default FavoriteBorderSharp]
            ["@material-ui/icons/FavoriteBorderTwoTone" :default FavoriteBorderTwoTone]
            ["@material-ui/icons/FavoriteOutlined" :default FavoriteOutlined]
            ["@material-ui/icons/FavoriteRounded" :default FavoriteRounded]
            ["@material-ui/icons/FavoriteSharp" :default FavoriteSharp]
            ["@material-ui/icons/FavoriteTwoTone" :default FavoriteTwoTone]
            ["@material-ui/icons/FeaturedPlayList" :default FeaturedPlayList]
            ["@material-ui/icons/FeaturedPlayListOutlined" :default FeaturedPlayListOutlined]
            ["@material-ui/icons/FeaturedPlayListRounded" :default FeaturedPlayListRounded]
            ["@material-ui/icons/FeaturedPlayListSharp" :default FeaturedPlayListSharp]
            ["@material-ui/icons/FeaturedPlayListTwoTone" :default FeaturedPlayListTwoTone]
            ["@material-ui/icons/FeaturedVideo" :default FeaturedVideo]
            ["@material-ui/icons/FeaturedVideoOutlined" :default FeaturedVideoOutlined]
            ["@material-ui/icons/FeaturedVideoRounded" :default FeaturedVideoRounded]
            ["@material-ui/icons/FeaturedVideoSharp" :default FeaturedVideoSharp]
            ["@material-ui/icons/FeaturedVideoTwoTone" :default FeaturedVideoTwoTone]
            ["@material-ui/icons/Feedback" :default Feedback]
            ["@material-ui/icons/FeedbackOutlined" :default FeedbackOutlined]
            ["@material-ui/icons/FeedbackRounded" :default FeedbackRounded]
            ["@material-ui/icons/FeedbackSharp" :default FeedbackSharp]
            ["@material-ui/icons/FeedbackTwoTone" :default FeedbackTwoTone]
            ["@material-ui/icons/FiberDvr" :default FiberDvr]
            ["@material-ui/icons/FiberDvrOutlined" :default FiberDvrOutlined]
            ["@material-ui/icons/FiberDvrRounded" :default FiberDvrRounded]
            ["@material-ui/icons/FiberDvrSharp" :default FiberDvrSharp]
            ["@material-ui/icons/FiberDvrTwoTone" :default FiberDvrTwoTone]
            ["@material-ui/icons/FiberManualRecord" :default FiberManualRecord]
            ["@material-ui/icons/FiberManualRecordOutlined" :default FiberManualRecordOutlined]
            ["@material-ui/icons/FiberManualRecordRounded" :default FiberManualRecordRounded]
            ["@material-ui/icons/FiberManualRecordSharp" :default FiberManualRecordSharp]
            ["@material-ui/icons/FiberManualRecordTwoTone" :default FiberManualRecordTwoTone]
            ["@material-ui/icons/FiberNew" :default FiberNew]
            ["@material-ui/icons/FiberNewOutlined" :default FiberNewOutlined]
            ["@material-ui/icons/FiberNewRounded" :default FiberNewRounded]
            ["@material-ui/icons/FiberNewSharp" :default FiberNewSharp]
            ["@material-ui/icons/FiberNewTwoTone" :default FiberNewTwoTone]
            ["@material-ui/icons/FiberPin" :default FiberPin]
            ["@material-ui/icons/FiberPinOutlined" :default FiberPinOutlined]
            ["@material-ui/icons/FiberPinRounded" :default FiberPinRounded]
            ["@material-ui/icons/FiberPinSharp" :default FiberPinSharp]
            ["@material-ui/icons/FiberPinTwoTone" :default FiberPinTwoTone]
            ["@material-ui/icons/FiberSmartRecord" :default FiberSmartRecord]
            ["@material-ui/icons/FiberSmartRecordOutlined" :default FiberSmartRecordOutlined]
            ["@material-ui/icons/FiberSmartRecordRounded" :default FiberSmartRecordRounded]
            ["@material-ui/icons/FiberSmartRecordSharp" :default FiberSmartRecordSharp]
            ["@material-ui/icons/FiberSmartRecordTwoTone" :default FiberSmartRecordTwoTone]
            ["@material-ui/icons/FileCopy" :default FileCopy]
            ["@material-ui/icons/FileCopyOutlined" :default FileCopyOutlined]
            ["@material-ui/icons/FileCopyRounded" :default FileCopyRounded]
            ["@material-ui/icons/FileCopySharp" :default FileCopySharp]
            ["@material-ui/icons/FileCopyTwoTone" :default FileCopyTwoTone]
            ["@material-ui/icons/Filter" :default Filter]
            ["@material-ui/icons/Filter1" :default Filter1]
            ["@material-ui/icons/Filter1Outlined" :default Filter1Outlined]
            ["@material-ui/icons/Filter1Rounded" :default Filter1Rounded]
            ["@material-ui/icons/Filter1Sharp" :default Filter1Sharp]
            ["@material-ui/icons/Filter1TwoTone" :default Filter1TwoTone]
            ["@material-ui/icons/Filter2" :default Filter2]
            ["@material-ui/icons/Filter2Outlined" :default Filter2Outlined]
            ["@material-ui/icons/Filter2Rounded" :default Filter2Rounded]
            ["@material-ui/icons/Filter2Sharp" :default Filter2Sharp]
            ["@material-ui/icons/Filter2TwoTone" :default Filter2TwoTone]
            ["@material-ui/icons/Filter3" :default Filter3]
            ["@material-ui/icons/Filter3Outlined" :default Filter3Outlined]
            ["@material-ui/icons/Filter3Rounded" :default Filter3Rounded]
            ["@material-ui/icons/Filter3Sharp" :default Filter3Sharp]
            ["@material-ui/icons/Filter3TwoTone" :default Filter3TwoTone]
            ["@material-ui/icons/Filter4" :default Filter4]
            ["@material-ui/icons/Filter4Outlined" :default Filter4Outlined]
            ["@material-ui/icons/Filter4Rounded" :default Filter4Rounded]
            ["@material-ui/icons/Filter4Sharp" :default Filter4Sharp]
            ["@material-ui/icons/Filter4TwoTone" :default Filter4TwoTone]
            ["@material-ui/icons/Filter5" :default Filter5]
            ["@material-ui/icons/Filter5Outlined" :default Filter5Outlined]
            ["@material-ui/icons/Filter5Rounded" :default Filter5Rounded]
            ["@material-ui/icons/Filter5Sharp" :default Filter5Sharp]
            ["@material-ui/icons/Filter5TwoTone" :default Filter5TwoTone]
            ["@material-ui/icons/Filter6" :default Filter6]
            ["@material-ui/icons/Filter6Outlined" :default Filter6Outlined]
            ["@material-ui/icons/Filter6Rounded" :default Filter6Rounded]
            ["@material-ui/icons/Filter6Sharp" :default Filter6Sharp]
            ["@material-ui/icons/Filter6TwoTone" :default Filter6TwoTone]
            ["@material-ui/icons/Filter7" :default Filter7]
            ["@material-ui/icons/Filter7Outlined" :default Filter7Outlined]
            ["@material-ui/icons/Filter7Rounded" :default Filter7Rounded]
            ["@material-ui/icons/Filter7Sharp" :default Filter7Sharp]
            ["@material-ui/icons/Filter7TwoTone" :default Filter7TwoTone]
            ["@material-ui/icons/Filter8" :default Filter8]
            ["@material-ui/icons/Filter8Outlined" :default Filter8Outlined]
            ["@material-ui/icons/Filter8Rounded" :default Filter8Rounded]
            ["@material-ui/icons/Filter8Sharp" :default Filter8Sharp]
            ["@material-ui/icons/Filter8TwoTone" :default Filter8TwoTone]
            ["@material-ui/icons/Filter9" :default Filter9]
            ["@material-ui/icons/Filter9Outlined" :default Filter9Outlined]
            ["@material-ui/icons/Filter9Plus" :default Filter9Plus]
            ["@material-ui/icons/Filter9PlusOutlined" :default Filter9PlusOutlined]
            ["@material-ui/icons/Filter9PlusRounded" :default Filter9PlusRounded]
            ["@material-ui/icons/Filter9PlusSharp" :default Filter9PlusSharp]
            ["@material-ui/icons/Filter9PlusTwoTone" :default Filter9PlusTwoTone]
            ["@material-ui/icons/Filter9Rounded" :default Filter9Rounded]
            ["@material-ui/icons/Filter9Sharp" :default Filter9Sharp]
            ["@material-ui/icons/Filter9TwoTone" :default Filter9TwoTone]
            ["@material-ui/icons/FilterBAndW" :default FilterBAndW]
            ["@material-ui/icons/FilterBAndWOutlined" :default FilterBAndWOutlined]
            ["@material-ui/icons/FilterBAndWRounded" :default FilterBAndWRounded]
            ["@material-ui/icons/FilterBAndWSharp" :default FilterBAndWSharp]
            ["@material-ui/icons/FilterBAndWTwoTone" :default FilterBAndWTwoTone]
            ["@material-ui/icons/FilterCenterFocus" :default FilterCenterFocus]
            ["@material-ui/icons/FilterCenterFocusOutlined" :default FilterCenterFocusOutlined]
            ["@material-ui/icons/FilterCenterFocusRounded" :default FilterCenterFocusRounded]
            ["@material-ui/icons/FilterCenterFocusSharp" :default FilterCenterFocusSharp]
            ["@material-ui/icons/FilterCenterFocusTwoTone" :default FilterCenterFocusTwoTone]
            ["@material-ui/icons/FilterDrama" :default FilterDrama]
            ["@material-ui/icons/FilterDramaOutlined" :default FilterDramaOutlined]
            ["@material-ui/icons/FilterDramaRounded" :default FilterDramaRounded]
            ["@material-ui/icons/FilterDramaSharp" :default FilterDramaSharp]
            ["@material-ui/icons/FilterDramaTwoTone" :default FilterDramaTwoTone]
            ["@material-ui/icons/FilterFrames" :default FilterFrames]
            ["@material-ui/icons/FilterFramesOutlined" :default FilterFramesOutlined]
            ["@material-ui/icons/FilterFramesRounded" :default FilterFramesRounded]
            ["@material-ui/icons/FilterFramesSharp" :default FilterFramesSharp]
            ["@material-ui/icons/FilterFramesTwoTone" :default FilterFramesTwoTone]
            ["@material-ui/icons/FilterHdr" :default FilterHdr]
            ["@material-ui/icons/FilterHdrOutlined" :default FilterHdrOutlined]
            ["@material-ui/icons/FilterHdrRounded" :default FilterHdrRounded]
            ["@material-ui/icons/FilterHdrSharp" :default FilterHdrSharp]
            ["@material-ui/icons/FilterHdrTwoTone" :default FilterHdrTwoTone]
            ["@material-ui/icons/FilterList" :default FilterList]
            ["@material-ui/icons/FilterListOutlined" :default FilterListOutlined]
            ["@material-ui/icons/FilterListRounded" :default FilterListRounded]
            ["@material-ui/icons/FilterListSharp" :default FilterListSharp]
            ["@material-ui/icons/FilterListTwoTone" :default FilterListTwoTone]
            ["@material-ui/icons/FilterNone" :default FilterNone]
            ["@material-ui/icons/FilterNoneOutlined" :default FilterNoneOutlined]
            ["@material-ui/icons/FilterNoneRounded" :default FilterNoneRounded]
            ["@material-ui/icons/FilterNoneSharp" :default FilterNoneSharp]
            ["@material-ui/icons/FilterNoneTwoTone" :default FilterNoneTwoTone]
            ["@material-ui/icons/FilterOutlined" :default FilterOutlined]
            ["@material-ui/icons/FilterRounded" :default FilterRounded]
            ["@material-ui/icons/FilterSharp" :default FilterSharp]
            ["@material-ui/icons/FilterTiltShift" :default FilterTiltShift]
            ["@material-ui/icons/FilterTiltShiftOutlined" :default FilterTiltShiftOutlined]
            ["@material-ui/icons/FilterTiltShiftRounded" :default FilterTiltShiftRounded]
            ["@material-ui/icons/FilterTiltShiftSharp" :default FilterTiltShiftSharp]
            ["@material-ui/icons/FilterTiltShiftTwoTone" :default FilterTiltShiftTwoTone]
            ["@material-ui/icons/FilterTwoTone" :default FilterTwoTone]
            ["@material-ui/icons/FilterVintage" :default FilterVintage]
            ["@material-ui/icons/FilterVintageOutlined" :default FilterVintageOutlined]
            ["@material-ui/icons/FilterVintageRounded" :default FilterVintageRounded]
            ["@material-ui/icons/FilterVintageSharp" :default FilterVintageSharp]
            ["@material-ui/icons/FilterVintageTwoTone" :default FilterVintageTwoTone]
            ["@material-ui/icons/FindInPage" :default FindInPage]
            ["@material-ui/icons/FindInPageOutlined" :default FindInPageOutlined]
            ["@material-ui/icons/FindInPageRounded" :default FindInPageRounded]
            ["@material-ui/icons/FindInPageSharp" :default FindInPageSharp]
            ["@material-ui/icons/FindInPageTwoTone" :default FindInPageTwoTone]
            ["@material-ui/icons/FindReplace" :default FindReplace]
            ["@material-ui/icons/FindReplaceOutlined" :default FindReplaceOutlined]
            ["@material-ui/icons/FindReplaceRounded" :default FindReplaceRounded]
            ["@material-ui/icons/FindReplaceSharp" :default FindReplaceSharp]
            ["@material-ui/icons/FindReplaceTwoTone" :default FindReplaceTwoTone]
            ["@material-ui/icons/Fingerprint" :default Fingerprint]
            ["@material-ui/icons/FingerprintOutlined" :default FingerprintOutlined]
            ["@material-ui/icons/FingerprintRounded" :default FingerprintRounded]
            ["@material-ui/icons/FingerprintSharp" :default FingerprintSharp]
            ["@material-ui/icons/FingerprintTwoTone" :default FingerprintTwoTone]
            ["@material-ui/icons/Fireplace" :default Fireplace]
            ["@material-ui/icons/FireplaceOutlined" :default FireplaceOutlined]
            ["@material-ui/icons/FireplaceRounded" :default FireplaceRounded]
            ["@material-ui/icons/FireplaceSharp" :default FireplaceSharp]
            ["@material-ui/icons/FireplaceTwoTone" :default FireplaceTwoTone]
            ["@material-ui/icons/FirstPage" :default FirstPage]
            ["@material-ui/icons/FirstPageOutlined" :default FirstPageOutlined]
            ["@material-ui/icons/FirstPageRounded" :default FirstPageRounded]
            ["@material-ui/icons/FirstPageSharp" :default FirstPageSharp]
            ["@material-ui/icons/FirstPageTwoTone" :default FirstPageTwoTone]
            ["@material-ui/icons/FitnessCenter" :default FitnessCenter]
            ["@material-ui/icons/FitnessCenterOutlined" :default FitnessCenterOutlined]
            ["@material-ui/icons/FitnessCenterRounded" :default FitnessCenterRounded]
            ["@material-ui/icons/FitnessCenterSharp" :default FitnessCenterSharp]
            ["@material-ui/icons/FitnessCenterTwoTone" :default FitnessCenterTwoTone]
            ["@material-ui/icons/Flag" :default Flag]
            ["@material-ui/icons/FlagOutlined" :default FlagOutlined]
            ["@material-ui/icons/FlagRounded" :default FlagRounded]
            ["@material-ui/icons/FlagSharp" :default FlagSharp]
            ["@material-ui/icons/FlagTwoTone" :default FlagTwoTone]
            ["@material-ui/icons/Flare" :default Flare]
            ["@material-ui/icons/FlareOutlined" :default FlareOutlined]
            ["@material-ui/icons/FlareRounded" :default FlareRounded]
            ["@material-ui/icons/FlareSharp" :default FlareSharp]
            ["@material-ui/icons/FlareTwoTone" :default FlareTwoTone]
            ["@material-ui/icons/FlashAuto" :default FlashAuto]
            ["@material-ui/icons/FlashAutoOutlined" :default FlashAutoOutlined]
            ["@material-ui/icons/FlashAutoRounded" :default FlashAutoRounded]
            ["@material-ui/icons/FlashAutoSharp" :default FlashAutoSharp]
            ["@material-ui/icons/FlashAutoTwoTone" :default FlashAutoTwoTone]
            ["@material-ui/icons/FlashOff" :default FlashOff]
            ["@material-ui/icons/FlashOffOutlined" :default FlashOffOutlined]
            ["@material-ui/icons/FlashOffRounded" :default FlashOffRounded]
            ["@material-ui/icons/FlashOffSharp" :default FlashOffSharp]
            ["@material-ui/icons/FlashOffTwoTone" :default FlashOffTwoTone]
            ["@material-ui/icons/FlashOn" :default FlashOn]
            ["@material-ui/icons/FlashOnOutlined" :default FlashOnOutlined]
            ["@material-ui/icons/FlashOnRounded" :default FlashOnRounded]
            ["@material-ui/icons/FlashOnSharp" :default FlashOnSharp]
            ["@material-ui/icons/FlashOnTwoTone" :default FlashOnTwoTone]
            ["@material-ui/icons/Flight" :default Flight]
            ["@material-ui/icons/FlightLand" :default FlightLand]
            ["@material-ui/icons/FlightLandOutlined" :default FlightLandOutlined]
            ["@material-ui/icons/FlightLandRounded" :default FlightLandRounded]
            ["@material-ui/icons/FlightLandSharp" :default FlightLandSharp]
            ["@material-ui/icons/FlightLandTwoTone" :default FlightLandTwoTone]
            ["@material-ui/icons/FlightOutlined" :default FlightOutlined]
            ["@material-ui/icons/FlightRounded" :default FlightRounded]
            ["@material-ui/icons/FlightSharp" :default FlightSharp]
            ["@material-ui/icons/FlightTakeoff" :default FlightTakeoff]
            ["@material-ui/icons/FlightTakeoffOutlined" :default FlightTakeoffOutlined]
            ["@material-ui/icons/FlightTakeoffRounded" :default FlightTakeoffRounded]
            ["@material-ui/icons/FlightTakeoffSharp" :default FlightTakeoffSharp]
            ["@material-ui/icons/FlightTakeoffTwoTone" :default FlightTakeoffTwoTone]
            ["@material-ui/icons/FlightTwoTone" :default FlightTwoTone]
            ["@material-ui/icons/Flip" :default Flip]
            ["@material-ui/icons/FlipCameraAndroid" :default FlipCameraAndroid]
            ["@material-ui/icons/FlipCameraAndroidOutlined" :default FlipCameraAndroidOutlined]
            ["@material-ui/icons/FlipCameraAndroidRounded" :default FlipCameraAndroidRounded]
            ["@material-ui/icons/FlipCameraAndroidSharp" :default FlipCameraAndroidSharp]
            ["@material-ui/icons/FlipCameraAndroidTwoTone" :default FlipCameraAndroidTwoTone]
            ["@material-ui/icons/FlipCameraIos" :default FlipCameraIos]
            ["@material-ui/icons/FlipCameraIosOutlined" :default FlipCameraIosOutlined]
            ["@material-ui/icons/FlipCameraIosRounded" :default FlipCameraIosRounded]
            ["@material-ui/icons/FlipCameraIosSharp" :default FlipCameraIosSharp]
            ["@material-ui/icons/FlipCameraIosTwoTone" :default FlipCameraIosTwoTone]
            ["@material-ui/icons/FlipOutlined" :default FlipOutlined]
            ["@material-ui/icons/FlipRounded" :default FlipRounded]
            ["@material-ui/icons/FlipSharp" :default FlipSharp]
            ["@material-ui/icons/FlipToBack" :default FlipToBack]
            ["@material-ui/icons/FlipToBackOutlined" :default FlipToBackOutlined]
            ["@material-ui/icons/FlipToBackRounded" :default FlipToBackRounded]
            ["@material-ui/icons/FlipToBackSharp" :default FlipToBackSharp]
            ["@material-ui/icons/FlipToBackTwoTone" :default FlipToBackTwoTone]
            ["@material-ui/icons/FlipToFront" :default FlipToFront]
            ["@material-ui/icons/FlipToFrontOutlined" :default FlipToFrontOutlined]
            ["@material-ui/icons/FlipToFrontRounded" :default FlipToFrontRounded]
            ["@material-ui/icons/FlipToFrontSharp" :default FlipToFrontSharp]
            ["@material-ui/icons/FlipToFrontTwoTone" :default FlipToFrontTwoTone]
            ["@material-ui/icons/FlipTwoTone" :default FlipTwoTone]
            ["@material-ui/icons/Folder" :default Folder]
            ["@material-ui/icons/FolderOpen" :default FolderOpen]
            ["@material-ui/icons/FolderOpenOutlined" :default FolderOpenOutlined]
            ["@material-ui/icons/FolderOpenRounded" :default FolderOpenRounded]
            ["@material-ui/icons/FolderOpenSharp" :default FolderOpenSharp]
            ["@material-ui/icons/FolderOpenTwoTone" :default FolderOpenTwoTone]
            ["@material-ui/icons/FolderOutlined" :default FolderOutlined]
            ["@material-ui/icons/FolderRounded" :default FolderRounded]
            ["@material-ui/icons/FolderShared" :default FolderShared]
            ["@material-ui/icons/FolderSharedOutlined" :default FolderSharedOutlined]
            ["@material-ui/icons/FolderSharedRounded" :default FolderSharedRounded]
            ["@material-ui/icons/FolderSharedSharp" :default FolderSharedSharp]
            ["@material-ui/icons/FolderSharedTwoTone" :default FolderSharedTwoTone]
            ["@material-ui/icons/FolderSharp" :default FolderSharp]
            ["@material-ui/icons/FolderSpecial" :default FolderSpecial]
            ["@material-ui/icons/FolderSpecialOutlined" :default FolderSpecialOutlined]
            ["@material-ui/icons/FolderSpecialRounded" :default FolderSpecialRounded]
            ["@material-ui/icons/FolderSpecialSharp" :default FolderSpecialSharp]
            ["@material-ui/icons/FolderSpecialTwoTone" :default FolderSpecialTwoTone]
            ["@material-ui/icons/FolderTwoTone" :default FolderTwoTone]
            ["@material-ui/icons/FontDownload" :default FontDownload]
            ["@material-ui/icons/FontDownloadOutlined" :default FontDownloadOutlined]
            ["@material-ui/icons/FontDownloadRounded" :default FontDownloadRounded]
            ["@material-ui/icons/FontDownloadSharp" :default FontDownloadSharp]
            ["@material-ui/icons/FontDownloadTwoTone" :default FontDownloadTwoTone]
            ["@material-ui/icons/FormatAlignCenter" :default FormatAlignCenter]
            ["@material-ui/icons/FormatAlignCenterOutlined" :default FormatAlignCenterOutlined]
            ["@material-ui/icons/FormatAlignCenterRounded" :default FormatAlignCenterRounded]
            ["@material-ui/icons/FormatAlignCenterSharp" :default FormatAlignCenterSharp]
            ["@material-ui/icons/FormatAlignCenterTwoTone" :default FormatAlignCenterTwoTone]
            ["@material-ui/icons/FormatAlignJustify" :default FormatAlignJustify]
            ["@material-ui/icons/FormatAlignJustifyOutlined" :default FormatAlignJustifyOutlined]
            ["@material-ui/icons/FormatAlignJustifyRounded" :default FormatAlignJustifyRounded]
            ["@material-ui/icons/FormatAlignJustifySharp" :default FormatAlignJustifySharp]
            ["@material-ui/icons/FormatAlignJustifyTwoTone" :default FormatAlignJustifyTwoTone]
            ["@material-ui/icons/FormatAlignLeft" :default FormatAlignLeft]
            ["@material-ui/icons/FormatAlignLeftOutlined" :default FormatAlignLeftOutlined]
            ["@material-ui/icons/FormatAlignLeftRounded" :default FormatAlignLeftRounded]
            ["@material-ui/icons/FormatAlignLeftSharp" :default FormatAlignLeftSharp]
            ["@material-ui/icons/FormatAlignLeftTwoTone" :default FormatAlignLeftTwoTone]
            ["@material-ui/icons/FormatAlignRight" :default FormatAlignRight]
            ["@material-ui/icons/FormatAlignRightOutlined" :default FormatAlignRightOutlined]
            ["@material-ui/icons/FormatAlignRightRounded" :default FormatAlignRightRounded]
            ["@material-ui/icons/FormatAlignRightSharp" :default FormatAlignRightSharp]
            ["@material-ui/icons/FormatAlignRightTwoTone" :default FormatAlignRightTwoTone]
            ["@material-ui/icons/FormatBold" :default FormatBold]
            ["@material-ui/icons/FormatBoldOutlined" :default FormatBoldOutlined]
            ["@material-ui/icons/FormatBoldRounded" :default FormatBoldRounded]
            ["@material-ui/icons/FormatBoldSharp" :default FormatBoldSharp]
            ["@material-ui/icons/FormatBoldTwoTone" :default FormatBoldTwoTone]
            ["@material-ui/icons/FormatClear" :default FormatClear]
            ["@material-ui/icons/FormatClearOutlined" :default FormatClearOutlined]
            ["@material-ui/icons/FormatClearRounded" :default FormatClearRounded]
            ["@material-ui/icons/FormatClearSharp" :default FormatClearSharp]
            ["@material-ui/icons/FormatClearTwoTone" :default FormatClearTwoTone]
            ["@material-ui/icons/FormatColorFill" :default FormatColorFill]
            ["@material-ui/icons/FormatColorFillOutlined" :default FormatColorFillOutlined]
            ["@material-ui/icons/FormatColorFillRounded" :default FormatColorFillRounded]
            ["@material-ui/icons/FormatColorFillSharp" :default FormatColorFillSharp]
            ["@material-ui/icons/FormatColorFillTwoTone" :default FormatColorFillTwoTone]
            ["@material-ui/icons/FormatColorReset" :default FormatColorReset]
            ["@material-ui/icons/FormatColorResetOutlined" :default FormatColorResetOutlined]
            ["@material-ui/icons/FormatColorResetRounded" :default FormatColorResetRounded]
            ["@material-ui/icons/FormatColorResetSharp" :default FormatColorResetSharp]
            ["@material-ui/icons/FormatColorResetTwoTone" :default FormatColorResetTwoTone]
            ["@material-ui/icons/FormatColorText" :default FormatColorText]
            ["@material-ui/icons/FormatColorTextOutlined" :default FormatColorTextOutlined]
            ["@material-ui/icons/FormatColorTextRounded" :default FormatColorTextRounded]
            ["@material-ui/icons/FormatColorTextSharp" :default FormatColorTextSharp]
            ["@material-ui/icons/FormatColorTextTwoTone" :default FormatColorTextTwoTone]
            ["@material-ui/icons/FormatIndentDecrease" :default FormatIndentDecrease]
            ["@material-ui/icons/FormatIndentDecreaseOutlined" :default FormatIndentDecreaseOutlined]
            ["@material-ui/icons/FormatIndentDecreaseRounded" :default FormatIndentDecreaseRounded]
            ["@material-ui/icons/FormatIndentDecreaseSharp" :default FormatIndentDecreaseSharp]
            ["@material-ui/icons/FormatIndentDecreaseTwoTone" :default FormatIndentDecreaseTwoTone]
            ["@material-ui/icons/FormatIndentIncrease" :default FormatIndentIncrease]
            ["@material-ui/icons/FormatIndentIncreaseOutlined" :default FormatIndentIncreaseOutlined]
            ["@material-ui/icons/FormatIndentIncreaseRounded" :default FormatIndentIncreaseRounded]
            ["@material-ui/icons/FormatIndentIncreaseSharp" :default FormatIndentIncreaseSharp]
            ["@material-ui/icons/FormatIndentIncreaseTwoTone" :default FormatIndentIncreaseTwoTone]
            ["@material-ui/icons/FormatItalic" :default FormatItalic]
            ["@material-ui/icons/FormatItalicOutlined" :default FormatItalicOutlined]
            ["@material-ui/icons/FormatItalicRounded" :default FormatItalicRounded]
            ["@material-ui/icons/FormatItalicSharp" :default FormatItalicSharp]
            ["@material-ui/icons/FormatItalicTwoTone" :default FormatItalicTwoTone]
            ["@material-ui/icons/FormatLineSpacing" :default FormatLineSpacing]
            ["@material-ui/icons/FormatLineSpacingOutlined" :default FormatLineSpacingOutlined]
            ["@material-ui/icons/FormatLineSpacingRounded" :default FormatLineSpacingRounded]
            ["@material-ui/icons/FormatLineSpacingSharp" :default FormatLineSpacingSharp]
            ["@material-ui/icons/FormatLineSpacingTwoTone" :default FormatLineSpacingTwoTone]
            ["@material-ui/icons/FormatListBulleted" :default FormatListBulleted]
            ["@material-ui/icons/FormatListBulletedOutlined" :default FormatListBulletedOutlined]
            ["@material-ui/icons/FormatListBulletedRounded" :default FormatListBulletedRounded]
            ["@material-ui/icons/FormatListBulletedSharp" :default FormatListBulletedSharp]
            ["@material-ui/icons/FormatListBulletedTwoTone" :default FormatListBulletedTwoTone]
            ["@material-ui/icons/FormatListNumbered" :default FormatListNumbered]
            ["@material-ui/icons/FormatListNumberedOutlined" :default FormatListNumberedOutlined]
            ["@material-ui/icons/FormatListNumberedRounded" :default FormatListNumberedRounded]
            ["@material-ui/icons/FormatListNumberedRtl" :default FormatListNumberedRtl]
            ["@material-ui/icons/FormatListNumberedRtlOutlined" :default FormatListNumberedRtlOutlined]
            ["@material-ui/icons/FormatListNumberedRtlRounded" :default FormatListNumberedRtlRounded]
            ["@material-ui/icons/FormatListNumberedRtlSharp" :default FormatListNumberedRtlSharp]
            ["@material-ui/icons/FormatListNumberedRtlTwoTone" :default FormatListNumberedRtlTwoTone]
            ["@material-ui/icons/FormatListNumberedSharp" :default FormatListNumberedSharp]
            ["@material-ui/icons/FormatListNumberedTwoTone" :default FormatListNumberedTwoTone]
            ["@material-ui/icons/FormatPaint" :default FormatPaint]
            ["@material-ui/icons/FormatPaintOutlined" :default FormatPaintOutlined]
            ["@material-ui/icons/FormatPaintRounded" :default FormatPaintRounded]
            ["@material-ui/icons/FormatPaintSharp" :default FormatPaintSharp]
            ["@material-ui/icons/FormatPaintTwoTone" :default FormatPaintTwoTone]
            ["@material-ui/icons/FormatQuote" :default FormatQuote]
            ["@material-ui/icons/FormatQuoteOutlined" :default FormatQuoteOutlined]
            ["@material-ui/icons/FormatQuoteRounded" :default FormatQuoteRounded]
            ["@material-ui/icons/FormatQuoteSharp" :default FormatQuoteSharp]
            ["@material-ui/icons/FormatQuoteTwoTone" :default FormatQuoteTwoTone]
            ["@material-ui/icons/FormatShapes" :default FormatShapes]
            ["@material-ui/icons/FormatShapesOutlined" :default FormatShapesOutlined]
            ["@material-ui/icons/FormatShapesRounded" :default FormatShapesRounded]
            ["@material-ui/icons/FormatShapesSharp" :default FormatShapesSharp]
            ["@material-ui/icons/FormatShapesTwoTone" :default FormatShapesTwoTone]
            ["@material-ui/icons/FormatSize" :default FormatSize]
            ["@material-ui/icons/FormatSizeOutlined" :default FormatSizeOutlined]
            ["@material-ui/icons/FormatSizeRounded" :default FormatSizeRounded]
            ["@material-ui/icons/FormatSizeSharp" :default FormatSizeSharp]
            ["@material-ui/icons/FormatSizeTwoTone" :default FormatSizeTwoTone]
            ["@material-ui/icons/FormatStrikethrough" :default FormatStrikethrough]
            ["@material-ui/icons/FormatStrikethroughOutlined" :default FormatStrikethroughOutlined]
            ["@material-ui/icons/FormatStrikethroughRounded" :default FormatStrikethroughRounded]
            ["@material-ui/icons/FormatStrikethroughSharp" :default FormatStrikethroughSharp]
            ["@material-ui/icons/FormatStrikethroughTwoTone" :default FormatStrikethroughTwoTone]
            ["@material-ui/icons/FormatTextdirectionLToR" :default FormatTextdirectionLToR]
            ["@material-ui/icons/FormatTextdirectionLToROutlined" :default FormatTextdirectionLToROutlined]
            ["@material-ui/icons/FormatTextdirectionLToRRounded" :default FormatTextdirectionLToRRounded]
            ["@material-ui/icons/FormatTextdirectionLToRSharp" :default FormatTextdirectionLToRSharp]
            ["@material-ui/icons/FormatTextdirectionLToRTwoTone" :default FormatTextdirectionLToRTwoTone]
            ["@material-ui/icons/FormatTextdirectionRToL" :default FormatTextdirectionRToL]
            ["@material-ui/icons/FormatTextdirectionRToLOutlined" :default FormatTextdirectionRToLOutlined]
            ["@material-ui/icons/FormatTextdirectionRToLRounded" :default FormatTextdirectionRToLRounded]
            ["@material-ui/icons/FormatTextdirectionRToLSharp" :default FormatTextdirectionRToLSharp]
            ["@material-ui/icons/FormatTextdirectionRToLTwoTone" :default FormatTextdirectionRToLTwoTone]
            ["@material-ui/icons/FormatUnderlined" :default FormatUnderlined]
            ["@material-ui/icons/FormatUnderlinedOutlined" :default FormatUnderlinedOutlined]
            ["@material-ui/icons/FormatUnderlinedRounded" :default FormatUnderlinedRounded]
            ["@material-ui/icons/FormatUnderlinedSharp" :default FormatUnderlinedSharp]
            ["@material-ui/icons/FormatUnderlinedTwoTone" :default FormatUnderlinedTwoTone]
            ["@material-ui/icons/Forum" :default Forum]
            ["@material-ui/icons/ForumOutlined" :default ForumOutlined]
            ["@material-ui/icons/ForumRounded" :default ForumRounded]
            ["@material-ui/icons/ForumSharp" :default ForumSharp]
            ["@material-ui/icons/ForumTwoTone" :default ForumTwoTone]
            ["@material-ui/icons/Forward" :default Forward]
            ["@material-ui/icons/Forward10" :default Forward10]
            ["@material-ui/icons/Forward10Outlined" :default Forward10Outlined]
            ["@material-ui/icons/Forward10Rounded" :default Forward10Rounded]
            ["@material-ui/icons/Forward10Sharp" :default Forward10Sharp]
            ["@material-ui/icons/Forward10TwoTone" :default Forward10TwoTone]
            ["@material-ui/icons/Forward30" :default Forward30]
            ["@material-ui/icons/Forward30Outlined" :default Forward30Outlined]
            ["@material-ui/icons/Forward30Rounded" :default Forward30Rounded]
            ["@material-ui/icons/Forward30Sharp" :default Forward30Sharp]
            ["@material-ui/icons/Forward30TwoTone" :default Forward30TwoTone]
            ["@material-ui/icons/Forward5" :default Forward5]
            ["@material-ui/icons/Forward5Outlined" :default Forward5Outlined]
            ["@material-ui/icons/Forward5Rounded" :default Forward5Rounded]
            ["@material-ui/icons/Forward5Sharp" :default Forward5Sharp]
            ["@material-ui/icons/Forward5TwoTone" :default Forward5TwoTone]
            ["@material-ui/icons/ForwardOutlined" :default ForwardOutlined]
            ["@material-ui/icons/ForwardRounded" :default ForwardRounded]
            ["@material-ui/icons/ForwardSharp" :default ForwardSharp]
            ["@material-ui/icons/ForwardTwoTone" :default ForwardTwoTone]
            ["@material-ui/icons/FourK" :default FourK]
            ["@material-ui/icons/FourKOutlined" :default FourKOutlined]
            ["@material-ui/icons/FourKRounded" :default FourKRounded]
            ["@material-ui/icons/FourKSharp" :default FourKSharp]
            ["@material-ui/icons/FourKTwoTone" :default FourKTwoTone]
            ["@material-ui/icons/FreeBreakfast" :default FreeBreakfast]
            ["@material-ui/icons/FreeBreakfastOutlined" :default FreeBreakfastOutlined]
            ["@material-ui/icons/FreeBreakfastRounded" :default FreeBreakfastRounded]
            ["@material-ui/icons/FreeBreakfastSharp" :default FreeBreakfastSharp]
            ["@material-ui/icons/FreeBreakfastTwoTone" :default FreeBreakfastTwoTone]
            ["@material-ui/icons/Fullscreen" :default Fullscreen]
            ["@material-ui/icons/FullscreenExit" :default FullscreenExit]
            ["@material-ui/icons/FullscreenExitOutlined" :default FullscreenExitOutlined]
            ["@material-ui/icons/FullscreenExitRounded" :default FullscreenExitRounded]
            ["@material-ui/icons/FullscreenExitSharp" :default FullscreenExitSharp]
            ["@material-ui/icons/FullscreenExitTwoTone" :default FullscreenExitTwoTone]
            ["@material-ui/icons/FullscreenOutlined" :default FullscreenOutlined]
            ["@material-ui/icons/FullscreenRounded" :default FullscreenRounded]
            ["@material-ui/icons/FullscreenSharp" :default FullscreenSharp]
            ["@material-ui/icons/FullscreenTwoTone" :default FullscreenTwoTone]
            ["@material-ui/icons/Functions" :default Functions]
            ["@material-ui/icons/FunctionsOutlined" :default FunctionsOutlined]
            ["@material-ui/icons/FunctionsRounded" :default FunctionsRounded]
            ["@material-ui/icons/FunctionsSharp" :default FunctionsSharp]
            ["@material-ui/icons/FunctionsTwoTone" :default FunctionsTwoTone]
            ["@material-ui/icons/Gamepad" :default Gamepad]
            ["@material-ui/icons/GamepadOutlined" :default GamepadOutlined]
            ["@material-ui/icons/GamepadRounded" :default GamepadRounded]
            ["@material-ui/icons/GamepadSharp" :default GamepadSharp]
            ["@material-ui/icons/GamepadTwoTone" :default GamepadTwoTone]
            ["@material-ui/icons/Games" :default Games]
            ["@material-ui/icons/GamesOutlined" :default GamesOutlined]
            ["@material-ui/icons/GamesRounded" :default GamesRounded]
            ["@material-ui/icons/GamesSharp" :default GamesSharp]
            ["@material-ui/icons/GamesTwoTone" :default GamesTwoTone]
            ["@material-ui/icons/Gavel" :default Gavel]
            ["@material-ui/icons/GavelOutlined" :default GavelOutlined]
            ["@material-ui/icons/GavelRounded" :default GavelRounded]
            ["@material-ui/icons/GavelSharp" :default GavelSharp]
            ["@material-ui/icons/GavelTwoTone" :default GavelTwoTone]
            ["@material-ui/icons/Gesture" :default Gesture]
            ["@material-ui/icons/GestureOutlined" :default GestureOutlined]
            ["@material-ui/icons/GestureRounded" :default GestureRounded]
            ["@material-ui/icons/GestureSharp" :default GestureSharp]
            ["@material-ui/icons/GestureTwoTone" :default GestureTwoTone]
            ["@material-ui/icons/GetApp" :default GetApp]
            ["@material-ui/icons/GetAppOutlined" :default GetAppOutlined]
            ["@material-ui/icons/GetAppRounded" :default GetAppRounded]
            ["@material-ui/icons/GetAppSharp" :default GetAppSharp]
            ["@material-ui/icons/GetAppTwoTone" :default GetAppTwoTone]
            ["@material-ui/icons/Gif" :default Gif]
            ["@material-ui/icons/GifOutlined" :default GifOutlined]
            ["@material-ui/icons/GifRounded" :default GifRounded]
            ["@material-ui/icons/GifSharp" :default GifSharp]
            ["@material-ui/icons/GifTwoTone" :default GifTwoTone]
            ["@material-ui/icons/GitHub" :default GitHub]
            ["@material-ui/icons/GolfCourse" :default GolfCourse]
            ["@material-ui/icons/GolfCourseOutlined" :default GolfCourseOutlined]
            ["@material-ui/icons/GolfCourseRounded" :default GolfCourseRounded]
            ["@material-ui/icons/GolfCourseSharp" :default GolfCourseSharp]
            ["@material-ui/icons/GolfCourseTwoTone" :default GolfCourseTwoTone]
            ["@material-ui/icons/GpsFixed" :default GpsFixed]
            ["@material-ui/icons/GpsFixedOutlined" :default GpsFixedOutlined]
            ["@material-ui/icons/GpsFixedRounded" :default GpsFixedRounded]
            ["@material-ui/icons/GpsFixedSharp" :default GpsFixedSharp]
            ["@material-ui/icons/GpsFixedTwoTone" :default GpsFixedTwoTone]
            ["@material-ui/icons/GpsNotFixed" :default GpsNotFixed]
            ["@material-ui/icons/GpsNotFixedOutlined" :default GpsNotFixedOutlined]
            ["@material-ui/icons/GpsNotFixedRounded" :default GpsNotFixedRounded]
            ["@material-ui/icons/GpsNotFixedSharp" :default GpsNotFixedSharp]
            ["@material-ui/icons/GpsNotFixedTwoTone" :default GpsNotFixedTwoTone]
            ["@material-ui/icons/GpsOff" :default GpsOff]
            ["@material-ui/icons/GpsOffOutlined" :default GpsOffOutlined]
            ["@material-ui/icons/GpsOffRounded" :default GpsOffRounded]
            ["@material-ui/icons/GpsOffSharp" :default GpsOffSharp]
            ["@material-ui/icons/GpsOffTwoTone" :default GpsOffTwoTone]
            ["@material-ui/icons/Grade" :default Grade]
            ["@material-ui/icons/GradeOutlined" :default GradeOutlined]
            ["@material-ui/icons/GradeRounded" :default GradeRounded]
            ["@material-ui/icons/GradeSharp" :default GradeSharp]
            ["@material-ui/icons/GradeTwoTone" :default GradeTwoTone]
            ["@material-ui/icons/Gradient" :default Gradient]
            ["@material-ui/icons/GradientOutlined" :default GradientOutlined]
            ["@material-ui/icons/GradientRounded" :default GradientRounded]
            ["@material-ui/icons/GradientSharp" :default GradientSharp]
            ["@material-ui/icons/GradientTwoTone" :default GradientTwoTone]
            ["@material-ui/icons/Grain" :default Grain]
            ["@material-ui/icons/GrainOutlined" :default GrainOutlined]
            ["@material-ui/icons/GrainRounded" :default GrainRounded]
            ["@material-ui/icons/GrainSharp" :default GrainSharp]
            ["@material-ui/icons/GrainTwoTone" :default GrainTwoTone]
            ["@material-ui/icons/GraphicEq" :default GraphicEq]
            ["@material-ui/icons/GraphicEqOutlined" :default GraphicEqOutlined]
            ["@material-ui/icons/GraphicEqRounded" :default GraphicEqRounded]
            ["@material-ui/icons/GraphicEqSharp" :default GraphicEqSharp]
            ["@material-ui/icons/GraphicEqTwoTone" :default GraphicEqTwoTone]
            ["@material-ui/icons/GridOff" :default GridOff]
            ["@material-ui/icons/GridOffOutlined" :default GridOffOutlined]
            ["@material-ui/icons/GridOffRounded" :default GridOffRounded]
            ["@material-ui/icons/GridOffSharp" :default GridOffSharp]
            ["@material-ui/icons/GridOffTwoTone" :default GridOffTwoTone]
            ["@material-ui/icons/GridOn" :default GridOn]
            ["@material-ui/icons/GridOnOutlined" :default GridOnOutlined]
            ["@material-ui/icons/GridOnRounded" :default GridOnRounded]
            ["@material-ui/icons/GridOnSharp" :default GridOnSharp]
            ["@material-ui/icons/GridOnTwoTone" :default GridOnTwoTone]
            ["@material-ui/icons/Group" :default Group]
            ["@material-ui/icons/GroupAdd" :default GroupAdd]
            ["@material-ui/icons/GroupAddOutlined" :default GroupAddOutlined]
            ["@material-ui/icons/GroupAddRounded" :default GroupAddRounded]
            ["@material-ui/icons/GroupAddSharp" :default GroupAddSharp]
            ["@material-ui/icons/GroupAddTwoTone" :default GroupAddTwoTone]
            ["@material-ui/icons/GroupOutlined" :default GroupOutlined]
            ["@material-ui/icons/GroupRounded" :default GroupRounded]
            ["@material-ui/icons/GroupSharp" :default GroupSharp]
            ["@material-ui/icons/GroupTwoTone" :default GroupTwoTone]
            ["@material-ui/icons/GroupWork" :default GroupWork]
            ["@material-ui/icons/GroupWorkOutlined" :default GroupWorkOutlined]
            ["@material-ui/icons/GroupWorkRounded" :default GroupWorkRounded]
            ["@material-ui/icons/GroupWorkSharp" :default GroupWorkSharp]
            ["@material-ui/icons/GroupWorkTwoTone" :default GroupWorkTwoTone]
            ["@material-ui/icons/GTranslate" :default GTranslate]
            ["@material-ui/icons/GTranslateOutlined" :default GTranslateOutlined]
            ["@material-ui/icons/GTranslateRounded" :default GTranslateRounded]
            ["@material-ui/icons/GTranslateSharp" :default GTranslateSharp]
            ["@material-ui/icons/GTranslateTwoTone" :default GTranslateTwoTone]
            ["@material-ui/icons/Hd" :default Hd]
            ["@material-ui/icons/HdOutlined" :default HdOutlined]
            ["@material-ui/icons/HdrOff" :default HdrOff]
            ["@material-ui/icons/HdrOffOutlined" :default HdrOffOutlined]
            ["@material-ui/icons/HdrOffRounded" :default HdrOffRounded]
            ["@material-ui/icons/HdrOffSharp" :default HdrOffSharp]
            ["@material-ui/icons/HdrOffTwoTone" :default HdrOffTwoTone]
            ["@material-ui/icons/HdrOn" :default HdrOn]
            ["@material-ui/icons/HdrOnOutlined" :default HdrOnOutlined]
            ["@material-ui/icons/HdrOnRounded" :default HdrOnRounded]
            ["@material-ui/icons/HdrOnSharp" :default HdrOnSharp]
            ["@material-ui/icons/HdrOnTwoTone" :default HdrOnTwoTone]
            ["@material-ui/icons/HdRounded" :default HdRounded]
            ["@material-ui/icons/HdrStrong" :default HdrStrong]
            ["@material-ui/icons/HdrStrongOutlined" :default HdrStrongOutlined]
            ["@material-ui/icons/HdrStrongRounded" :default HdrStrongRounded]
            ["@material-ui/icons/HdrStrongSharp" :default HdrStrongSharp]
            ["@material-ui/icons/HdrStrongTwoTone" :default HdrStrongTwoTone]
            ["@material-ui/icons/HdrWeak" :default HdrWeak]
            ["@material-ui/icons/HdrWeakOutlined" :default HdrWeakOutlined]
            ["@material-ui/icons/HdrWeakRounded" :default HdrWeakRounded]
            ["@material-ui/icons/HdrWeakSharp" :default HdrWeakSharp]
            ["@material-ui/icons/HdrWeakTwoTone" :default HdrWeakTwoTone]
            ["@material-ui/icons/HdSharp" :default HdSharp]
            ["@material-ui/icons/HdTwoTone" :default HdTwoTone]
            ["@material-ui/icons/Headset" :default Headset]
            ["@material-ui/icons/HeadsetMic" :default HeadsetMic]
            ["@material-ui/icons/HeadsetMicOutlined" :default HeadsetMicOutlined]
            ["@material-ui/icons/HeadsetMicRounded" :default HeadsetMicRounded]
            ["@material-ui/icons/HeadsetMicSharp" :default HeadsetMicSharp]
            ["@material-ui/icons/HeadsetMicTwoTone" :default HeadsetMicTwoTone]
            ["@material-ui/icons/HeadsetOutlined" :default HeadsetOutlined]
            ["@material-ui/icons/HeadsetRounded" :default HeadsetRounded]
            ["@material-ui/icons/HeadsetSharp" :default HeadsetSharp]
            ["@material-ui/icons/HeadsetTwoTone" :default HeadsetTwoTone]
            ["@material-ui/icons/Healing" :default Healing]
            ["@material-ui/icons/HealingOutlined" :default HealingOutlined]
            ["@material-ui/icons/HealingRounded" :default HealingRounded]
            ["@material-ui/icons/HealingSharp" :default HealingSharp]
            ["@material-ui/icons/HealingTwoTone" :default HealingTwoTone]
            ["@material-ui/icons/Hearing" :default Hearing]
            ["@material-ui/icons/HearingOutlined" :default HearingOutlined]
            ["@material-ui/icons/HearingRounded" :default HearingRounded]
            ["@material-ui/icons/HearingSharp" :default HearingSharp]
            ["@material-ui/icons/HearingTwoTone" :default HearingTwoTone]
            ["@material-ui/icons/Height" :default Height]
            ["@material-ui/icons/HeightOutlined" :default HeightOutlined]
            ["@material-ui/icons/HeightRounded" :default HeightRounded]
            ["@material-ui/icons/HeightSharp" :default HeightSharp]
            ["@material-ui/icons/HeightTwoTone" :default HeightTwoTone]
            ["@material-ui/icons/Help" :default Help]
            ["@material-ui/icons/HelpOutline" :default HelpOutline]
            ["@material-ui/icons/HelpOutlined" :default HelpOutlined]
            ["@material-ui/icons/HelpOutlineOutlined" :default HelpOutlineOutlined]
            ["@material-ui/icons/HelpOutlineRounded" :default HelpOutlineRounded]
            ["@material-ui/icons/HelpOutlineSharp" :default HelpOutlineSharp]
            ["@material-ui/icons/HelpOutlineTwoTone" :default HelpOutlineTwoTone]
            ["@material-ui/icons/HelpRounded" :default HelpRounded]
            ["@material-ui/icons/HelpSharp" :default HelpSharp]
            ["@material-ui/icons/HelpTwoTone" :default HelpTwoTone]
            ["@material-ui/icons/Highlight" :default Highlight]
            ["@material-ui/icons/HighlightOff" :default HighlightOff]
            ["@material-ui/icons/HighlightOffOutlined" :default HighlightOffOutlined]
            ["@material-ui/icons/HighlightOffRounded" :default HighlightOffRounded]
            ["@material-ui/icons/HighlightOffSharp" :default HighlightOffSharp]
            ["@material-ui/icons/HighlightOffTwoTone" :default HighlightOffTwoTone]
            ["@material-ui/icons/HighlightOutlined" :default HighlightOutlined]
            ["@material-ui/icons/HighlightRounded" :default HighlightRounded]
            ["@material-ui/icons/HighlightSharp" :default HighlightSharp]
            ["@material-ui/icons/HighlightTwoTone" :default HighlightTwoTone]
            ["@material-ui/icons/HighQuality" :default HighQuality]
            ["@material-ui/icons/HighQualityOutlined" :default HighQualityOutlined]
            ["@material-ui/icons/HighQualityRounded" :default HighQualityRounded]
            ["@material-ui/icons/HighQualitySharp" :default HighQualitySharp]
            ["@material-ui/icons/HighQualityTwoTone" :default HighQualityTwoTone]
            ["@material-ui/icons/History" :default History]
            ["@material-ui/icons/HistoryOutlined" :default HistoryOutlined]
            ["@material-ui/icons/HistoryRounded" :default HistoryRounded]
            ["@material-ui/icons/HistorySharp" :default HistorySharp]
            ["@material-ui/icons/HistoryTwoTone" :default HistoryTwoTone]
            ["@material-ui/icons/Home" :default Home]
            ["@material-ui/icons/HomeOutlined" :default HomeOutlined]
            ["@material-ui/icons/HomeRounded" :default HomeRounded]
            ["@material-ui/icons/HomeSharp" :default HomeSharp]
            ["@material-ui/icons/HomeTwoTone" :default HomeTwoTone]
            ["@material-ui/icons/HomeWork" :default HomeWork]
            ["@material-ui/icons/HomeWorkOutlined" :default HomeWorkOutlined]
            ["@material-ui/icons/HomeWorkRounded" :default HomeWorkRounded]
            ["@material-ui/icons/HomeWorkSharp" :default HomeWorkSharp]
            ["@material-ui/icons/HomeWorkTwoTone" :default HomeWorkTwoTone]
            ["@material-ui/icons/HorizontalSplit" :default HorizontalSplit]
            ["@material-ui/icons/HorizontalSplitOutlined" :default HorizontalSplitOutlined]
            ["@material-ui/icons/HorizontalSplitRounded" :default HorizontalSplitRounded]
            ["@material-ui/icons/HorizontalSplitSharp" :default HorizontalSplitSharp]
            ["@material-ui/icons/HorizontalSplitTwoTone" :default HorizontalSplitTwoTone]
            ["@material-ui/icons/Hotel" :default Hotel]
            ["@material-ui/icons/HotelOutlined" :default HotelOutlined]
            ["@material-ui/icons/HotelRounded" :default HotelRounded]
            ["@material-ui/icons/HotelSharp" :default HotelSharp]
            ["@material-ui/icons/HotelTwoTone" :default HotelTwoTone]
            ["@material-ui/icons/HotTub" :default HotTub]
            ["@material-ui/icons/HotTubOutlined" :default HotTubOutlined]
            ["@material-ui/icons/HotTubRounded" :default HotTubRounded]
            ["@material-ui/icons/HotTubSharp" :default HotTubSharp]
            ["@material-ui/icons/HotTubTwoTone" :default HotTubTwoTone]
            ["@material-ui/icons/HourglassEmpty" :default HourglassEmpty]
            ["@material-ui/icons/HourglassEmptyOutlined" :default HourglassEmptyOutlined]
            ["@material-ui/icons/HourglassEmptyRounded" :default HourglassEmptyRounded]
            ["@material-ui/icons/HourglassEmptySharp" :default HourglassEmptySharp]
            ["@material-ui/icons/HourglassEmptyTwoTone" :default HourglassEmptyTwoTone]
            ["@material-ui/icons/HourglassFull" :default HourglassFull]
            ["@material-ui/icons/HourglassFullOutlined" :default HourglassFullOutlined]
            ["@material-ui/icons/HourglassFullRounded" :default HourglassFullRounded]
            ["@material-ui/icons/HourglassFullSharp" :default HourglassFullSharp]
            ["@material-ui/icons/HourglassFullTwoTone" :default HourglassFullTwoTone]
            ["@material-ui/icons/House" :default House]
            ["@material-ui/icons/HouseOutlined" :default HouseOutlined]
            ["@material-ui/icons/HouseRounded" :default HouseRounded]
            ["@material-ui/icons/HouseSharp" :default HouseSharp]
            ["@material-ui/icons/HouseTwoTone" :default HouseTwoTone]
            ["@material-ui/icons/HowToReg" :default HowToReg]
            ["@material-ui/icons/HowToRegOutlined" :default HowToRegOutlined]
            ["@material-ui/icons/HowToRegRounded" :default HowToRegRounded]
            ["@material-ui/icons/HowToRegSharp" :default HowToRegSharp]
            ["@material-ui/icons/HowToRegTwoTone" :default HowToRegTwoTone]
            ["@material-ui/icons/HowToVote" :default HowToVote]
            ["@material-ui/icons/HowToVoteOutlined" :default HowToVoteOutlined]
            ["@material-ui/icons/HowToVoteRounded" :default HowToVoteRounded]
            ["@material-ui/icons/HowToVoteSharp" :default HowToVoteSharp]
            ["@material-ui/icons/HowToVoteTwoTone" :default HowToVoteTwoTone]
            ["@material-ui/icons/Http" :default Http]
            ["@material-ui/icons/HttpOutlined" :default HttpOutlined]
            ["@material-ui/icons/HttpRounded" :default HttpRounded]
            ["@material-ui/icons/Https" :default Https]
            ["@material-ui/icons/HttpSharp" :default HttpSharp]
            ["@material-ui/icons/HttpsOutlined" :default HttpsOutlined]
            ["@material-ui/icons/HttpsRounded" :default HttpsRounded]
            ["@material-ui/icons/HttpsSharp" :default HttpsSharp]
            ["@material-ui/icons/HttpsTwoTone" :default HttpsTwoTone]
            ["@material-ui/icons/HttpTwoTone" :default HttpTwoTone]
            ["@material-ui/icons/Image" :default Image]
            ["@material-ui/icons/ImageAspectRatio" :default ImageAspectRatio]
            ["@material-ui/icons/ImageAspectRatioOutlined" :default ImageAspectRatioOutlined]
            ["@material-ui/icons/ImageAspectRatioRounded" :default ImageAspectRatioRounded]
            ["@material-ui/icons/ImageAspectRatioSharp" :default ImageAspectRatioSharp]
            ["@material-ui/icons/ImageAspectRatioTwoTone" :default ImageAspectRatioTwoTone]
            ["@material-ui/icons/ImageOutlined" :default ImageOutlined]
            ["@material-ui/icons/ImageRounded" :default ImageRounded]
            ["@material-ui/icons/ImageSearch" :default ImageSearch]
            ["@material-ui/icons/ImageSearchOutlined" :default ImageSearchOutlined]
            ["@material-ui/icons/ImageSearchRounded" :default ImageSearchRounded]
            ["@material-ui/icons/ImageSearchSharp" :default ImageSearchSharp]
            ["@material-ui/icons/ImageSearchTwoTone" :default ImageSearchTwoTone]
            ["@material-ui/icons/ImageSharp" :default ImageSharp]
            ["@material-ui/icons/ImageTwoTone" :default ImageTwoTone]
            ["@material-ui/icons/ImportantDevices" :default ImportantDevices]
            ["@material-ui/icons/ImportantDevicesOutlined" :default ImportantDevicesOutlined]
            ["@material-ui/icons/ImportantDevicesRounded" :default ImportantDevicesRounded]
            ["@material-ui/icons/ImportantDevicesSharp" :default ImportantDevicesSharp]
            ["@material-ui/icons/ImportantDevicesTwoTone" :default ImportantDevicesTwoTone]
            ["@material-ui/icons/ImportContacts" :default ImportContacts]
            ["@material-ui/icons/ImportContactsOutlined" :default ImportContactsOutlined]
            ["@material-ui/icons/ImportContactsRounded" :default ImportContactsRounded]
            ["@material-ui/icons/ImportContactsSharp" :default ImportContactsSharp]
            ["@material-ui/icons/ImportContactsTwoTone" :default ImportContactsTwoTone]
            ["@material-ui/icons/ImportExport" :default ImportExport]
            ["@material-ui/icons/ImportExportOutlined" :default ImportExportOutlined]
            ["@material-ui/icons/ImportExportRounded" :default ImportExportRounded]
            ["@material-ui/icons/ImportExportSharp" :default ImportExportSharp]
            ["@material-ui/icons/ImportExportTwoTone" :default ImportExportTwoTone]
            ["@material-ui/icons/Inbox" :default Inbox]
            ["@material-ui/icons/InboxOutlined" :default InboxOutlined]
            ["@material-ui/icons/InboxRounded" :default InboxRounded]
            ["@material-ui/icons/InboxSharp" :default InboxSharp]
            ["@material-ui/icons/InboxTwoTone" :default InboxTwoTone]
            ["@material-ui/icons/IndeterminateCheckBox" :default IndeterminateCheckBox]
            ["@material-ui/icons/IndeterminateCheckBoxOutlined" :default IndeterminateCheckBoxOutlined]
            ["@material-ui/icons/IndeterminateCheckBoxRounded" :default IndeterminateCheckBoxRounded]
            ["@material-ui/icons/IndeterminateCheckBoxSharp" :default IndeterminateCheckBoxSharp]
            ["@material-ui/icons/IndeterminateCheckBoxTwoTone" :default IndeterminateCheckBoxTwoTone]
            ["@material-ui/icons/Info" :default Info]
            ["@material-ui/icons/InfoOutlined" :default InfoOutlined]
            ["@material-ui/icons/InfoRounded" :default InfoRounded]
            ["@material-ui/icons/InfoSharp" :default InfoSharp]
            ["@material-ui/icons/InfoTwoTone" :default InfoTwoTone]
            ["@material-ui/icons/Input" :default Input]
            ["@material-ui/icons/InputOutlined" :default InputOutlined]
            ["@material-ui/icons/InputRounded" :default InputRounded]
            ["@material-ui/icons/InputSharp" :default InputSharp]
            ["@material-ui/icons/InputTwoTone" :default InputTwoTone]
            ["@material-ui/icons/InsertChart" :default InsertChart]
            ["@material-ui/icons/InsertChartOutlined" :default InsertChartOutlined]
            ["@material-ui/icons/InsertChartOutlinedOutlined" :default InsertChartOutlinedOutlined]
            ["@material-ui/icons/InsertChartOutlinedRounded" :default InsertChartOutlinedRounded]
            ["@material-ui/icons/InsertChartOutlinedSharp" :default InsertChartOutlinedSharp]
            ["@material-ui/icons/InsertChartOutlinedTwoTone" :default InsertChartOutlinedTwoTone]
            ["@material-ui/icons/InsertChartRounded" :default InsertChartRounded]
            ["@material-ui/icons/InsertChartSharp" :default InsertChartSharp]
            ["@material-ui/icons/InsertChartTwoTone" :default InsertChartTwoTone]
            ["@material-ui/icons/InsertComment" :default InsertComment]
            ["@material-ui/icons/InsertCommentOutlined" :default InsertCommentOutlined]
            ["@material-ui/icons/InsertCommentRounded" :default InsertCommentRounded]
            ["@material-ui/icons/InsertCommentSharp" :default InsertCommentSharp]
            ["@material-ui/icons/InsertCommentTwoTone" :default InsertCommentTwoTone]
            ["@material-ui/icons/InsertDriveFile" :default InsertDriveFile]
            ["@material-ui/icons/InsertDriveFileOutlined" :default InsertDriveFileOutlined]
            ["@material-ui/icons/InsertDriveFileRounded" :default InsertDriveFileRounded]
            ["@material-ui/icons/InsertDriveFileSharp" :default InsertDriveFileSharp]
            ["@material-ui/icons/InsertDriveFileTwoTone" :default InsertDriveFileTwoTone]
            ["@material-ui/icons/InsertEmoticon" :default InsertEmoticon]
            ["@material-ui/icons/InsertEmoticonOutlined" :default InsertEmoticonOutlined]
            ["@material-ui/icons/InsertEmoticonRounded" :default InsertEmoticonRounded]
            ["@material-ui/icons/InsertEmoticonSharp" :default InsertEmoticonSharp]
            ["@material-ui/icons/InsertEmoticonTwoTone" :default InsertEmoticonTwoTone]
            ["@material-ui/icons/InsertInvitation" :default InsertInvitation]
            ["@material-ui/icons/InsertInvitationOutlined" :default InsertInvitationOutlined]
            ["@material-ui/icons/InsertInvitationRounded" :default InsertInvitationRounded]
            ["@material-ui/icons/InsertInvitationSharp" :default InsertInvitationSharp]
            ["@material-ui/icons/InsertInvitationTwoTone" :default InsertInvitationTwoTone]
            ["@material-ui/icons/InsertLink" :default InsertLink]
            ["@material-ui/icons/InsertLinkOutlined" :default InsertLinkOutlined]
            ["@material-ui/icons/InsertLinkRounded" :default InsertLinkRounded]
            ["@material-ui/icons/InsertLinkSharp" :default InsertLinkSharp]
            ["@material-ui/icons/InsertLinkTwoTone" :default InsertLinkTwoTone]
            ["@material-ui/icons/InsertPhoto" :default InsertPhoto]
            ["@material-ui/icons/InsertPhotoOutlined" :default InsertPhotoOutlined]
            ["@material-ui/icons/InsertPhotoRounded" :default InsertPhotoRounded]
            ["@material-ui/icons/InsertPhotoSharp" :default InsertPhotoSharp]
            ["@material-ui/icons/InsertPhotoTwoTone" :default InsertPhotoTwoTone]
            ["@material-ui/icons/Instagram" :default Instagram]
            ["@material-ui/icons/InvertColors" :default InvertColors]
            ["@material-ui/icons/InvertColorsOff" :default InvertColorsOff]
            ["@material-ui/icons/InvertColorsOffOutlined" :default InvertColorsOffOutlined]
            ["@material-ui/icons/InvertColorsOffRounded" :default InvertColorsOffRounded]
            ["@material-ui/icons/InvertColorsOffSharp" :default InvertColorsOffSharp]
            ["@material-ui/icons/InvertColorsOffTwoTone" :default InvertColorsOffTwoTone]
            ["@material-ui/icons/InvertColorsOutlined" :default InvertColorsOutlined]
            ["@material-ui/icons/InvertColorsRounded" :default InvertColorsRounded]
            ["@material-ui/icons/InvertColorsSharp" :default InvertColorsSharp]
            ["@material-ui/icons/InvertColorsTwoTone" :default InvertColorsTwoTone]
            ["@material-ui/icons/Iso" :default Iso]
            ["@material-ui/icons/IsoOutlined" :default IsoOutlined]
            ["@material-ui/icons/IsoRounded" :default IsoRounded]
            ["@material-ui/icons/IsoSharp" :default IsoSharp]
            ["@material-ui/icons/IsoTwoTone" :default IsoTwoTone]
            ["@material-ui/icons/Keyboard" :default Keyboard]
            ["@material-ui/icons/KeyboardArrowDown" :default KeyboardArrowDown]
            ["@material-ui/icons/KeyboardArrowDownOutlined" :default KeyboardArrowDownOutlined]
            ["@material-ui/icons/KeyboardArrowDownRounded" :default KeyboardArrowDownRounded]
            ["@material-ui/icons/KeyboardArrowDownSharp" :default KeyboardArrowDownSharp]
            ["@material-ui/icons/KeyboardArrowDownTwoTone" :default KeyboardArrowDownTwoTone]
            ["@material-ui/icons/KeyboardArrowLeft" :default KeyboardArrowLeft]
            ["@material-ui/icons/KeyboardArrowLeftOutlined" :default KeyboardArrowLeftOutlined]
            ["@material-ui/icons/KeyboardArrowLeftRounded" :default KeyboardArrowLeftRounded]
            ["@material-ui/icons/KeyboardArrowLeftSharp" :default KeyboardArrowLeftSharp]
            ["@material-ui/icons/KeyboardArrowLeftTwoTone" :default KeyboardArrowLeftTwoTone]
            ["@material-ui/icons/KeyboardArrowRight" :default KeyboardArrowRight]
            ["@material-ui/icons/KeyboardArrowRightOutlined" :default KeyboardArrowRightOutlined]
            ["@material-ui/icons/KeyboardArrowRightRounded" :default KeyboardArrowRightRounded]
            ["@material-ui/icons/KeyboardArrowRightSharp" :default KeyboardArrowRightSharp]
            ["@material-ui/icons/KeyboardArrowRightTwoTone" :default KeyboardArrowRightTwoTone]
            ["@material-ui/icons/KeyboardArrowUp" :default KeyboardArrowUp]
            ["@material-ui/icons/KeyboardArrowUpOutlined" :default KeyboardArrowUpOutlined]
            ["@material-ui/icons/KeyboardArrowUpRounded" :default KeyboardArrowUpRounded]
            ["@material-ui/icons/KeyboardArrowUpSharp" :default KeyboardArrowUpSharp]
            ["@material-ui/icons/KeyboardArrowUpTwoTone" :default KeyboardArrowUpTwoTone]
            ["@material-ui/icons/KeyboardBackspace" :default KeyboardBackspace]
            ["@material-ui/icons/KeyboardBackspaceOutlined" :default KeyboardBackspaceOutlined]
            ["@material-ui/icons/KeyboardBackspaceRounded" :default KeyboardBackspaceRounded]
            ["@material-ui/icons/KeyboardBackspaceSharp" :default KeyboardBackspaceSharp]
            ["@material-ui/icons/KeyboardBackspaceTwoTone" :default KeyboardBackspaceTwoTone]
            ["@material-ui/icons/KeyboardCapslock" :default KeyboardCapslock]
            ["@material-ui/icons/KeyboardCapslockOutlined" :default KeyboardCapslockOutlined]
            ["@material-ui/icons/KeyboardCapslockRounded" :default KeyboardCapslockRounded]
            ["@material-ui/icons/KeyboardCapslockSharp" :default KeyboardCapslockSharp]
            ["@material-ui/icons/KeyboardCapslockTwoTone" :default KeyboardCapslockTwoTone]
            ["@material-ui/icons/KeyboardHide" :default KeyboardHide]
            ["@material-ui/icons/KeyboardHideOutlined" :default KeyboardHideOutlined]
            ["@material-ui/icons/KeyboardHideRounded" :default KeyboardHideRounded]
            ["@material-ui/icons/KeyboardHideSharp" :default KeyboardHideSharp]
            ["@material-ui/icons/KeyboardHideTwoTone" :default KeyboardHideTwoTone]
            ["@material-ui/icons/KeyboardOutlined" :default KeyboardOutlined]
            ["@material-ui/icons/KeyboardReturn" :default KeyboardReturn]
            ["@material-ui/icons/KeyboardReturnOutlined" :default KeyboardReturnOutlined]
            ["@material-ui/icons/KeyboardReturnRounded" :default KeyboardReturnRounded]
            ["@material-ui/icons/KeyboardReturnSharp" :default KeyboardReturnSharp]
            ["@material-ui/icons/KeyboardReturnTwoTone" :default KeyboardReturnTwoTone]
            ["@material-ui/icons/KeyboardRounded" :default KeyboardRounded]
            ["@material-ui/icons/KeyboardSharp" :default KeyboardSharp]
            ["@material-ui/icons/KeyboardTab" :default KeyboardTab]
            ["@material-ui/icons/KeyboardTabOutlined" :default KeyboardTabOutlined]
            ["@material-ui/icons/KeyboardTabRounded" :default KeyboardTabRounded]
            ["@material-ui/icons/KeyboardTabSharp" :default KeyboardTabSharp]
            ["@material-ui/icons/KeyboardTabTwoTone" :default KeyboardTabTwoTone]
            ["@material-ui/icons/KeyboardTwoTone" :default KeyboardTwoTone]
            ["@material-ui/icons/KeyboardVoice" :default KeyboardVoice]
            ["@material-ui/icons/KeyboardVoiceOutlined" :default KeyboardVoiceOutlined]
            ["@material-ui/icons/KeyboardVoiceRounded" :default KeyboardVoiceRounded]
            ["@material-ui/icons/KeyboardVoiceSharp" :default KeyboardVoiceSharp]
            ["@material-ui/icons/KeyboardVoiceTwoTone" :default KeyboardVoiceTwoTone]
            ["@material-ui/icons/KingBed" :default KingBed]
            ["@material-ui/icons/KingBedOutlined" :default KingBedOutlined]
            ["@material-ui/icons/KingBedRounded" :default KingBedRounded]
            ["@material-ui/icons/KingBedSharp" :default KingBedSharp]
            ["@material-ui/icons/KingBedTwoTone" :default KingBedTwoTone]
            ["@material-ui/icons/Kitchen" :default Kitchen]
            ["@material-ui/icons/KitchenOutlined" :default KitchenOutlined]
            ["@material-ui/icons/KitchenRounded" :default KitchenRounded]
            ["@material-ui/icons/KitchenSharp" :default KitchenSharp]
            ["@material-ui/icons/KitchenTwoTone" :default KitchenTwoTone]
            ["@material-ui/icons/Label" :default Label]
            ["@material-ui/icons/LabelImportant" :default LabelImportant]
            ["@material-ui/icons/LabelImportantOutlined" :default LabelImportantOutlined]
            ["@material-ui/icons/LabelImportantRounded" :default LabelImportantRounded]
            ["@material-ui/icons/LabelImportantSharp" :default LabelImportantSharp]
            ["@material-ui/icons/LabelImportantTwoTone" :default LabelImportantTwoTone]
            ["@material-ui/icons/LabelOff" :default LabelOff]
            ["@material-ui/icons/LabelOffOutlined" :default LabelOffOutlined]
            ["@material-ui/icons/LabelOffRounded" :default LabelOffRounded]
            ["@material-ui/icons/LabelOffSharp" :default LabelOffSharp]
            ["@material-ui/icons/LabelOffTwoTone" :default LabelOffTwoTone]
            ["@material-ui/icons/LabelOutlined" :default LabelOutlined]
            ["@material-ui/icons/LabelRounded" :default LabelRounded]
            ["@material-ui/icons/LabelSharp" :default LabelSharp]
            ["@material-ui/icons/LabelTwoTone" :default LabelTwoTone]
            ["@material-ui/icons/Landscape" :default Landscape]
            ["@material-ui/icons/LandscapeOutlined" :default LandscapeOutlined]
            ["@material-ui/icons/LandscapeRounded" :default LandscapeRounded]
            ["@material-ui/icons/LandscapeSharp" :default LandscapeSharp]
            ["@material-ui/icons/LandscapeTwoTone" :default LandscapeTwoTone]
            ["@material-ui/icons/Language" :default Language]
            ["@material-ui/icons/LanguageOutlined" :default LanguageOutlined]
            ["@material-ui/icons/LanguageRounded" :default LanguageRounded]
            ["@material-ui/icons/LanguageSharp" :default LanguageSharp]
            ["@material-ui/icons/LanguageTwoTone" :default LanguageTwoTone]
            ["@material-ui/icons/Laptop" :default Laptop]
            ["@material-ui/icons/LaptopChromebook" :default LaptopChromebook]
            ["@material-ui/icons/LaptopChromebookOutlined" :default LaptopChromebookOutlined]
            ["@material-ui/icons/LaptopChromebookRounded" :default LaptopChromebookRounded]
            ["@material-ui/icons/LaptopChromebookSharp" :default LaptopChromebookSharp]
            ["@material-ui/icons/LaptopChromebookTwoTone" :default LaptopChromebookTwoTone]
            ["@material-ui/icons/LaptopMac" :default LaptopMac]
            ["@material-ui/icons/LaptopMacOutlined" :default LaptopMacOutlined]
            ["@material-ui/icons/LaptopMacRounded" :default LaptopMacRounded]
            ["@material-ui/icons/LaptopMacSharp" :default LaptopMacSharp]
            ["@material-ui/icons/LaptopMacTwoTone" :default LaptopMacTwoTone]
            ["@material-ui/icons/LaptopOutlined" :default LaptopOutlined]
            ["@material-ui/icons/LaptopRounded" :default LaptopRounded]
            ["@material-ui/icons/LaptopSharp" :default LaptopSharp]
            ["@material-ui/icons/LaptopTwoTone" :default LaptopTwoTone]
            ["@material-ui/icons/LaptopWindows" :default LaptopWindows]
            ["@material-ui/icons/LaptopWindowsOutlined" :default LaptopWindowsOutlined]
            ["@material-ui/icons/LaptopWindowsRounded" :default LaptopWindowsRounded]
            ["@material-ui/icons/LaptopWindowsSharp" :default LaptopWindowsSharp]
            ["@material-ui/icons/LaptopWindowsTwoTone" :default LaptopWindowsTwoTone]
            ["@material-ui/icons/LastPage" :default LastPage]
            ["@material-ui/icons/LastPageOutlined" :default LastPageOutlined]
            ["@material-ui/icons/LastPageRounded" :default LastPageRounded]
            ["@material-ui/icons/LastPageSharp" :default LastPageSharp]
            ["@material-ui/icons/LastPageTwoTone" :default LastPageTwoTone]
            ["@material-ui/icons/Launch" :default Launch]
            ["@material-ui/icons/LaunchOutlined" :default LaunchOutlined]
            ["@material-ui/icons/LaunchRounded" :default LaunchRounded]
            ["@material-ui/icons/LaunchSharp" :default LaunchSharp]
            ["@material-ui/icons/LaunchTwoTone" :default LaunchTwoTone]
            ["@material-ui/icons/Layers" :default Layers]
            ["@material-ui/icons/LayersClear" :default LayersClear]
            ["@material-ui/icons/LayersClearOutlined" :default LayersClearOutlined]
            ["@material-ui/icons/LayersClearRounded" :default LayersClearRounded]
            ["@material-ui/icons/LayersClearSharp" :default LayersClearSharp]
            ["@material-ui/icons/LayersClearTwoTone" :default LayersClearTwoTone]
            ["@material-ui/icons/LayersOutlined" :default LayersOutlined]
            ["@material-ui/icons/LayersRounded" :default LayersRounded]
            ["@material-ui/icons/LayersSharp" :default LayersSharp]
            ["@material-ui/icons/LayersTwoTone" :default LayersTwoTone]
            ["@material-ui/icons/LeakAdd" :default LeakAdd]
            ["@material-ui/icons/LeakAddOutlined" :default LeakAddOutlined]
            ["@material-ui/icons/LeakAddRounded" :default LeakAddRounded]
            ["@material-ui/icons/LeakAddSharp" :default LeakAddSharp]
            ["@material-ui/icons/LeakAddTwoTone" :default LeakAddTwoTone]
            ["@material-ui/icons/LeakRemove" :default LeakRemove]
            ["@material-ui/icons/LeakRemoveOutlined" :default LeakRemoveOutlined]
            ["@material-ui/icons/LeakRemoveRounded" :default LeakRemoveRounded]
            ["@material-ui/icons/LeakRemoveSharp" :default LeakRemoveSharp]
            ["@material-ui/icons/LeakRemoveTwoTone" :default LeakRemoveTwoTone]
            ["@material-ui/icons/Lens" :default Lens]
            ["@material-ui/icons/LensOutlined" :default LensOutlined]
            ["@material-ui/icons/LensRounded" :default LensRounded]
            ["@material-ui/icons/LensSharp" :default LensSharp]
            ["@material-ui/icons/LensTwoTone" :default LensTwoTone]
            ["@material-ui/icons/LibraryAdd" :default LibraryAdd]
            ["@material-ui/icons/LibraryAddCheck" :default LibraryAddCheck]
            ["@material-ui/icons/LibraryAddCheckOutlined" :default LibraryAddCheckOutlined]
            ["@material-ui/icons/LibraryAddCheckRounded" :default LibraryAddCheckRounded]
            ["@material-ui/icons/LibraryAddCheckSharp" :default LibraryAddCheckSharp]
            ["@material-ui/icons/LibraryAddCheckTwoTone" :default LibraryAddCheckTwoTone]
            ["@material-ui/icons/LibraryAddOutlined" :default LibraryAddOutlined]
            ["@material-ui/icons/LibraryAddRounded" :default LibraryAddRounded]
            ["@material-ui/icons/LibraryAddSharp" :default LibraryAddSharp]
            ["@material-ui/icons/LibraryAddTwoTone" :default LibraryAddTwoTone]
            ["@material-ui/icons/LibraryBooks" :default LibraryBooks]
            ["@material-ui/icons/LibraryBooksOutlined" :default LibraryBooksOutlined]
            ["@material-ui/icons/LibraryBooksRounded" :default LibraryBooksRounded]
            ["@material-ui/icons/LibraryBooksSharp" :default LibraryBooksSharp]
            ["@material-ui/icons/LibraryBooksTwoTone" :default LibraryBooksTwoTone]
            ["@material-ui/icons/LibraryMusic" :default LibraryMusic]
            ["@material-ui/icons/LibraryMusicOutlined" :default LibraryMusicOutlined]
            ["@material-ui/icons/LibraryMusicRounded" :default LibraryMusicRounded]
            ["@material-ui/icons/LibraryMusicSharp" :default LibraryMusicSharp]
            ["@material-ui/icons/LibraryMusicTwoTone" :default LibraryMusicTwoTone]
            ["@material-ui/icons/LinearScale" :default LinearScale]
            ["@material-ui/icons/LinearScaleOutlined" :default LinearScaleOutlined]
            ["@material-ui/icons/LinearScaleRounded" :default LinearScaleRounded]
            ["@material-ui/icons/LinearScaleSharp" :default LinearScaleSharp]
            ["@material-ui/icons/LinearScaleTwoTone" :default LinearScaleTwoTone]
            ["@material-ui/icons/LineStyle" :default LineStyle]
            ["@material-ui/icons/LineStyleOutlined" :default LineStyleOutlined]
            ["@material-ui/icons/LineStyleRounded" :default LineStyleRounded]
            ["@material-ui/icons/LineStyleSharp" :default LineStyleSharp]
            ["@material-ui/icons/LineStyleTwoTone" :default LineStyleTwoTone]
            ["@material-ui/icons/LineWeight" :default LineWeight]
            ["@material-ui/icons/LineWeightOutlined" :default LineWeightOutlined]
            ["@material-ui/icons/LineWeightRounded" :default LineWeightRounded]
            ["@material-ui/icons/LineWeightSharp" :default LineWeightSharp]
            ["@material-ui/icons/LineWeightTwoTone" :default LineWeightTwoTone]
            ["@material-ui/icons/Link" :default Link]
            ["@material-ui/icons/LinkedCamera" :default LinkedCamera]
            ["@material-ui/icons/LinkedCameraOutlined" :default LinkedCameraOutlined]
            ["@material-ui/icons/LinkedCameraRounded" :default LinkedCameraRounded]
            ["@material-ui/icons/LinkedCameraSharp" :default LinkedCameraSharp]
            ["@material-ui/icons/LinkedCameraTwoTone" :default LinkedCameraTwoTone]
            ["@material-ui/icons/LinkedIn" :default LinkedIn]
            ["@material-ui/icons/LinkOff" :default LinkOff]
            ["@material-ui/icons/LinkOffOutlined" :default LinkOffOutlined]
            ["@material-ui/icons/LinkOffRounded" :default LinkOffRounded]
            ["@material-ui/icons/LinkOffSharp" :default LinkOffSharp]
            ["@material-ui/icons/LinkOffTwoTone" :default LinkOffTwoTone]
            ["@material-ui/icons/LinkOutlined" :default LinkOutlined]
            ["@material-ui/icons/LinkRounded" :default LinkRounded]
            ["@material-ui/icons/LinkSharp" :default LinkSharp]
            ["@material-ui/icons/LinkTwoTone" :default LinkTwoTone]
            ["@material-ui/icons/List" :default List]
            ["@material-ui/icons/ListAlt" :default ListAlt]
            ["@material-ui/icons/ListAltOutlined" :default ListAltOutlined]
            ["@material-ui/icons/ListAltRounded" :default ListAltRounded]
            ["@material-ui/icons/ListAltSharp" :default ListAltSharp]
            ["@material-ui/icons/ListAltTwoTone" :default ListAltTwoTone]
            ["@material-ui/icons/ListOutlined" :default ListOutlined]
            ["@material-ui/icons/ListRounded" :default ListRounded]
            ["@material-ui/icons/ListSharp" :default ListSharp]
            ["@material-ui/icons/ListTwoTone" :default ListTwoTone]
            ["@material-ui/icons/LiveHelp" :default LiveHelp]
            ["@material-ui/icons/LiveHelpOutlined" :default LiveHelpOutlined]
            ["@material-ui/icons/LiveHelpRounded" :default LiveHelpRounded]
            ["@material-ui/icons/LiveHelpSharp" :default LiveHelpSharp]
            ["@material-ui/icons/LiveHelpTwoTone" :default LiveHelpTwoTone]
            ["@material-ui/icons/LiveTv" :default LiveTv]
            ["@material-ui/icons/LiveTvOutlined" :default LiveTvOutlined]
            ["@material-ui/icons/LiveTvRounded" :default LiveTvRounded]
            ["@material-ui/icons/LiveTvSharp" :default LiveTvSharp]
            ["@material-ui/icons/LiveTvTwoTone" :default LiveTvTwoTone]
            ["@material-ui/icons/LocalActivity" :default LocalActivity]
            ["@material-ui/icons/LocalActivityOutlined" :default LocalActivityOutlined]
            ["@material-ui/icons/LocalActivityRounded" :default LocalActivityRounded]
            ["@material-ui/icons/LocalActivitySharp" :default LocalActivitySharp]
            ["@material-ui/icons/LocalActivityTwoTone" :default LocalActivityTwoTone]
            ["@material-ui/icons/LocalAirport" :default LocalAirport]
            ["@material-ui/icons/LocalAirportOutlined" :default LocalAirportOutlined]
            ["@material-ui/icons/LocalAirportRounded" :default LocalAirportRounded]
            ["@material-ui/icons/LocalAirportSharp" :default LocalAirportSharp]
            ["@material-ui/icons/LocalAirportTwoTone" :default LocalAirportTwoTone]
            ["@material-ui/icons/LocalAtm" :default LocalAtm]
            ["@material-ui/icons/LocalAtmOutlined" :default LocalAtmOutlined]
            ["@material-ui/icons/LocalAtmRounded" :default LocalAtmRounded]
            ["@material-ui/icons/LocalAtmSharp" :default LocalAtmSharp]
            ["@material-ui/icons/LocalAtmTwoTone" :default LocalAtmTwoTone]
            ["@material-ui/icons/LocalBar" :default LocalBar]
            ["@material-ui/icons/LocalBarOutlined" :default LocalBarOutlined]
            ["@material-ui/icons/LocalBarRounded" :default LocalBarRounded]
            ["@material-ui/icons/LocalBarSharp" :default LocalBarSharp]
            ["@material-ui/icons/LocalBarTwoTone" :default LocalBarTwoTone]
            ["@material-ui/icons/LocalCafe" :default LocalCafe]
            ["@material-ui/icons/LocalCafeOutlined" :default LocalCafeOutlined]
            ["@material-ui/icons/LocalCafeRounded" :default LocalCafeRounded]
            ["@material-ui/icons/LocalCafeSharp" :default LocalCafeSharp]
            ["@material-ui/icons/LocalCafeTwoTone" :default LocalCafeTwoTone]
            ["@material-ui/icons/LocalCarWash" :default LocalCarWash]
            ["@material-ui/icons/LocalCarWashOutlined" :default LocalCarWashOutlined]
            ["@material-ui/icons/LocalCarWashRounded" :default LocalCarWashRounded]
            ["@material-ui/icons/LocalCarWashSharp" :default LocalCarWashSharp]
            ["@material-ui/icons/LocalCarWashTwoTone" :default LocalCarWashTwoTone]
            ["@material-ui/icons/LocalConvenienceStore" :default LocalConvenienceStore]
            ["@material-ui/icons/LocalConvenienceStoreOutlined" :default LocalConvenienceStoreOutlined]
            ["@material-ui/icons/LocalConvenienceStoreRounded" :default LocalConvenienceStoreRounded]
            ["@material-ui/icons/LocalConvenienceStoreSharp" :default LocalConvenienceStoreSharp]
            ["@material-ui/icons/LocalConvenienceStoreTwoTone" :default LocalConvenienceStoreTwoTone]
            ["@material-ui/icons/LocalDining" :default LocalDining]
            ["@material-ui/icons/LocalDiningOutlined" :default LocalDiningOutlined]
            ["@material-ui/icons/LocalDiningRounded" :default LocalDiningRounded]
            ["@material-ui/icons/LocalDiningSharp" :default LocalDiningSharp]
            ["@material-ui/icons/LocalDiningTwoTone" :default LocalDiningTwoTone]
            ["@material-ui/icons/LocalDrink" :default LocalDrink]
            ["@material-ui/icons/LocalDrinkOutlined" :default LocalDrinkOutlined]
            ["@material-ui/icons/LocalDrinkRounded" :default LocalDrinkRounded]
            ["@material-ui/icons/LocalDrinkSharp" :default LocalDrinkSharp]
            ["@material-ui/icons/LocalDrinkTwoTone" :default LocalDrinkTwoTone]
            ["@material-ui/icons/LocalFlorist" :default LocalFlorist]
            ["@material-ui/icons/LocalFloristOutlined" :default LocalFloristOutlined]
            ["@material-ui/icons/LocalFloristRounded" :default LocalFloristRounded]
            ["@material-ui/icons/LocalFloristSharp" :default LocalFloristSharp]
            ["@material-ui/icons/LocalFloristTwoTone" :default LocalFloristTwoTone]
            ["@material-ui/icons/LocalGasStation" :default LocalGasStation]
            ["@material-ui/icons/LocalGasStationOutlined" :default LocalGasStationOutlined]
            ["@material-ui/icons/LocalGasStationRounded" :default LocalGasStationRounded]
            ["@material-ui/icons/LocalGasStationSharp" :default LocalGasStationSharp]
            ["@material-ui/icons/LocalGasStationTwoTone" :default LocalGasStationTwoTone]
            ["@material-ui/icons/LocalGroceryStore" :default LocalGroceryStore]
            ["@material-ui/icons/LocalGroceryStoreOutlined" :default LocalGroceryStoreOutlined]
            ["@material-ui/icons/LocalGroceryStoreRounded" :default LocalGroceryStoreRounded]
            ["@material-ui/icons/LocalGroceryStoreSharp" :default LocalGroceryStoreSharp]
            ["@material-ui/icons/LocalGroceryStoreTwoTone" :default LocalGroceryStoreTwoTone]
            ["@material-ui/icons/LocalHospital" :default LocalHospital]
            ["@material-ui/icons/LocalHospitalOutlined" :default LocalHospitalOutlined]
            ["@material-ui/icons/LocalHospitalRounded" :default LocalHospitalRounded]
            ["@material-ui/icons/LocalHospitalSharp" :default LocalHospitalSharp]
            ["@material-ui/icons/LocalHospitalTwoTone" :default LocalHospitalTwoTone]
            ["@material-ui/icons/LocalHotel" :default LocalHotel]
            ["@material-ui/icons/LocalHotelOutlined" :default LocalHotelOutlined]
            ["@material-ui/icons/LocalHotelRounded" :default LocalHotelRounded]
            ["@material-ui/icons/LocalHotelSharp" :default LocalHotelSharp]
            ["@material-ui/icons/LocalHotelTwoTone" :default LocalHotelTwoTone]
            ["@material-ui/icons/LocalLaundryService" :default LocalLaundryService]
            ["@material-ui/icons/LocalLaundryServiceOutlined" :default LocalLaundryServiceOutlined]
            ["@material-ui/icons/LocalLaundryServiceRounded" :default LocalLaundryServiceRounded]
            ["@material-ui/icons/LocalLaundryServiceSharp" :default LocalLaundryServiceSharp]
            ["@material-ui/icons/LocalLaundryServiceTwoTone" :default LocalLaundryServiceTwoTone]
            ["@material-ui/icons/LocalLibrary" :default LocalLibrary]
            ["@material-ui/icons/LocalLibraryOutlined" :default LocalLibraryOutlined]
            ["@material-ui/icons/LocalLibraryRounded" :default LocalLibraryRounded]
            ["@material-ui/icons/LocalLibrarySharp" :default LocalLibrarySharp]
            ["@material-ui/icons/LocalLibraryTwoTone" :default LocalLibraryTwoTone]
            ["@material-ui/icons/LocalMall" :default LocalMall]
            ["@material-ui/icons/LocalMallOutlined" :default LocalMallOutlined]
            ["@material-ui/icons/LocalMallRounded" :default LocalMallRounded]
            ["@material-ui/icons/LocalMallSharp" :default LocalMallSharp]
            ["@material-ui/icons/LocalMallTwoTone" :default LocalMallTwoTone]
            ["@material-ui/icons/LocalMovies" :default LocalMovies]
            ["@material-ui/icons/LocalMoviesOutlined" :default LocalMoviesOutlined]
            ["@material-ui/icons/LocalMoviesRounded" :default LocalMoviesRounded]
            ["@material-ui/icons/LocalMoviesSharp" :default LocalMoviesSharp]
            ["@material-ui/icons/LocalMoviesTwoTone" :default LocalMoviesTwoTone]
            ["@material-ui/icons/LocalOffer" :default LocalOffer]
            ["@material-ui/icons/LocalOfferOutlined" :default LocalOfferOutlined]
            ["@material-ui/icons/LocalOfferRounded" :default LocalOfferRounded]
            ["@material-ui/icons/LocalOfferSharp" :default LocalOfferSharp]
            ["@material-ui/icons/LocalOfferTwoTone" :default LocalOfferTwoTone]
            ["@material-ui/icons/LocalParking" :default LocalParking]
            ["@material-ui/icons/LocalParkingOutlined" :default LocalParkingOutlined]
            ["@material-ui/icons/LocalParkingRounded" :default LocalParkingRounded]
            ["@material-ui/icons/LocalParkingSharp" :default LocalParkingSharp]
            ["@material-ui/icons/LocalParkingTwoTone" :default LocalParkingTwoTone]
            ["@material-ui/icons/LocalPharmacy" :default LocalPharmacy]
            ["@material-ui/icons/LocalPharmacyOutlined" :default LocalPharmacyOutlined]
            ["@material-ui/icons/LocalPharmacyRounded" :default LocalPharmacyRounded]
            ["@material-ui/icons/LocalPharmacySharp" :default LocalPharmacySharp]
            ["@material-ui/icons/LocalPharmacyTwoTone" :default LocalPharmacyTwoTone]
            ["@material-ui/icons/LocalPhone" :default LocalPhone]
            ["@material-ui/icons/LocalPhoneOutlined" :default LocalPhoneOutlined]
            ["@material-ui/icons/LocalPhoneRounded" :default LocalPhoneRounded]
            ["@material-ui/icons/LocalPhoneSharp" :default LocalPhoneSharp]
            ["@material-ui/icons/LocalPhoneTwoTone" :default LocalPhoneTwoTone]
            ["@material-ui/icons/LocalPizza" :default LocalPizza]
            ["@material-ui/icons/LocalPizzaOutlined" :default LocalPizzaOutlined]
            ["@material-ui/icons/LocalPizzaRounded" :default LocalPizzaRounded]
            ["@material-ui/icons/LocalPizzaSharp" :default LocalPizzaSharp]
            ["@material-ui/icons/LocalPizzaTwoTone" :default LocalPizzaTwoTone]
            ["@material-ui/icons/LocalPlay" :default LocalPlay]
            ["@material-ui/icons/LocalPlayOutlined" :default LocalPlayOutlined]
            ["@material-ui/icons/LocalPlayRounded" :default LocalPlayRounded]
            ["@material-ui/icons/LocalPlaySharp" :default LocalPlaySharp]
            ["@material-ui/icons/LocalPlayTwoTone" :default LocalPlayTwoTone]
            ["@material-ui/icons/LocalPostOffice" :default LocalPostOffice]
            ["@material-ui/icons/LocalPostOfficeOutlined" :default LocalPostOfficeOutlined]
            ["@material-ui/icons/LocalPostOfficeRounded" :default LocalPostOfficeRounded]
            ["@material-ui/icons/LocalPostOfficeSharp" :default LocalPostOfficeSharp]
            ["@material-ui/icons/LocalPostOfficeTwoTone" :default LocalPostOfficeTwoTone]
            ["@material-ui/icons/LocalPrintshop" :default LocalPrintshop]
            ["@material-ui/icons/LocalPrintshopOutlined" :default LocalPrintshopOutlined]
            ["@material-ui/icons/LocalPrintshopRounded" :default LocalPrintshopRounded]
            ["@material-ui/icons/LocalPrintshopSharp" :default LocalPrintshopSharp]
            ["@material-ui/icons/LocalPrintshopTwoTone" :default LocalPrintshopTwoTone]
            ["@material-ui/icons/LocalSee" :default LocalSee]
            ["@material-ui/icons/LocalSeeOutlined" :default LocalSeeOutlined]
            ["@material-ui/icons/LocalSeeRounded" :default LocalSeeRounded]
            ["@material-ui/icons/LocalSeeSharp" :default LocalSeeSharp]
            ["@material-ui/icons/LocalSeeTwoTone" :default LocalSeeTwoTone]
            ["@material-ui/icons/LocalShipping" :default LocalShipping]
            ["@material-ui/icons/LocalShippingOutlined" :default LocalShippingOutlined]
            ["@material-ui/icons/LocalShippingRounded" :default LocalShippingRounded]
            ["@material-ui/icons/LocalShippingSharp" :default LocalShippingSharp]
            ["@material-ui/icons/LocalShippingTwoTone" :default LocalShippingTwoTone]
            ["@material-ui/icons/LocalTaxi" :default LocalTaxi]
            ["@material-ui/icons/LocalTaxiOutlined" :default LocalTaxiOutlined]
            ["@material-ui/icons/LocalTaxiRounded" :default LocalTaxiRounded]
            ["@material-ui/icons/LocalTaxiSharp" :default LocalTaxiSharp]
            ["@material-ui/icons/LocalTaxiTwoTone" :default LocalTaxiTwoTone]
            ["@material-ui/icons/LocationCity" :default LocationCity]
            ["@material-ui/icons/LocationCityOutlined" :default LocationCityOutlined]
            ["@material-ui/icons/LocationCityRounded" :default LocationCityRounded]
            ["@material-ui/icons/LocationCitySharp" :default LocationCitySharp]
            ["@material-ui/icons/LocationCityTwoTone" :default LocationCityTwoTone]
            ["@material-ui/icons/LocationDisabled" :default LocationDisabled]
            ["@material-ui/icons/LocationDisabledOutlined" :default LocationDisabledOutlined]
            ["@material-ui/icons/LocationDisabledRounded" :default LocationDisabledRounded]
            ["@material-ui/icons/LocationDisabledSharp" :default LocationDisabledSharp]
            ["@material-ui/icons/LocationDisabledTwoTone" :default LocationDisabledTwoTone]
            ["@material-ui/icons/LocationOff" :default LocationOff]
            ["@material-ui/icons/LocationOffOutlined" :default LocationOffOutlined]
            ["@material-ui/icons/LocationOffRounded" :default LocationOffRounded]
            ["@material-ui/icons/LocationOffSharp" :default LocationOffSharp]
            ["@material-ui/icons/LocationOffTwoTone" :default LocationOffTwoTone]
            ["@material-ui/icons/LocationOn" :default LocationOn]
            ["@material-ui/icons/LocationOnOutlined" :default LocationOnOutlined]
            ["@material-ui/icons/LocationOnRounded" :default LocationOnRounded]
            ["@material-ui/icons/LocationOnSharp" :default LocationOnSharp]
            ["@material-ui/icons/LocationOnTwoTone" :default LocationOnTwoTone]
            ["@material-ui/icons/LocationSearching" :default LocationSearching]
            ["@material-ui/icons/LocationSearchingOutlined" :default LocationSearchingOutlined]
            ["@material-ui/icons/LocationSearchingRounded" :default LocationSearchingRounded]
            ["@material-ui/icons/LocationSearchingSharp" :default LocationSearchingSharp]
            ["@material-ui/icons/LocationSearchingTwoTone" :default LocationSearchingTwoTone]
            ["@material-ui/icons/Lock" :default Lock]
            ["@material-ui/icons/LockOpen" :default LockOpen]
            ["@material-ui/icons/LockOpenOutlined" :default LockOpenOutlined]
            ["@material-ui/icons/LockOpenRounded" :default LockOpenRounded]
            ["@material-ui/icons/LockOpenSharp" :default LockOpenSharp]
            ["@material-ui/icons/LockOpenTwoTone" :default LockOpenTwoTone]
            ["@material-ui/icons/LockOutlined" :default LockOutlined]
            ["@material-ui/icons/LockRounded" :default LockRounded]
            ["@material-ui/icons/LockSharp" :default LockSharp]
            ["@material-ui/icons/LockTwoTone" :default LockTwoTone]
            ["@material-ui/icons/Looks" :default Looks]
            ["@material-ui/icons/Looks3" :default Looks3]
            ["@material-ui/icons/Looks3Outlined" :default Looks3Outlined]
            ["@material-ui/icons/Looks3Rounded" :default Looks3Rounded]
            ["@material-ui/icons/Looks3Sharp" :default Looks3Sharp]
            ["@material-ui/icons/Looks3TwoTone" :default Looks3TwoTone]
            ["@material-ui/icons/Looks4" :default Looks4]
            ["@material-ui/icons/Looks4Outlined" :default Looks4Outlined]
            ["@material-ui/icons/Looks4Rounded" :default Looks4Rounded]
            ["@material-ui/icons/Looks4Sharp" :default Looks4Sharp]
            ["@material-ui/icons/Looks4TwoTone" :default Looks4TwoTone]
            ["@material-ui/icons/Looks5" :default Looks5]
            ["@material-ui/icons/Looks5Outlined" :default Looks5Outlined]
            ["@material-ui/icons/Looks5Rounded" :default Looks5Rounded]
            ["@material-ui/icons/Looks5Sharp" :default Looks5Sharp]
            ["@material-ui/icons/Looks5TwoTone" :default Looks5TwoTone]
            ["@material-ui/icons/Looks6" :default Looks6]
            ["@material-ui/icons/Looks6Outlined" :default Looks6Outlined]
            ["@material-ui/icons/Looks6Rounded" :default Looks6Rounded]
            ["@material-ui/icons/Looks6Sharp" :default Looks6Sharp]
            ["@material-ui/icons/Looks6TwoTone" :default Looks6TwoTone]
            ["@material-ui/icons/LooksOne" :default LooksOne]
            ["@material-ui/icons/LooksOneOutlined" :default LooksOneOutlined]
            ["@material-ui/icons/LooksOneRounded" :default LooksOneRounded]
            ["@material-ui/icons/LooksOneSharp" :default LooksOneSharp]
            ["@material-ui/icons/LooksOneTwoTone" :default LooksOneTwoTone]
            ["@material-ui/icons/LooksOutlined" :default LooksOutlined]
            ["@material-ui/icons/LooksRounded" :default LooksRounded]
            ["@material-ui/icons/LooksSharp" :default LooksSharp]
            ["@material-ui/icons/LooksTwo" :default LooksTwo]
            ["@material-ui/icons/LooksTwoOutlined" :default LooksTwoOutlined]
            ["@material-ui/icons/LooksTwoRounded" :default LooksTwoRounded]
            ["@material-ui/icons/LooksTwoSharp" :default LooksTwoSharp]
            ["@material-ui/icons/LooksTwoTone" :default LooksTwoTone]
            ["@material-ui/icons/LooksTwoTwoTone" :default LooksTwoTwoTone]
            ["@material-ui/icons/Loop" :default Loop]
            ["@material-ui/icons/LoopOutlined" :default LoopOutlined]
            ["@material-ui/icons/LoopRounded" :default LoopRounded]
            ["@material-ui/icons/LoopSharp" :default LoopSharp]
            ["@material-ui/icons/LoopTwoTone" :default LoopTwoTone]
            ["@material-ui/icons/Loupe" :default Loupe]
            ["@material-ui/icons/LoupeOutlined" :default LoupeOutlined]
            ["@material-ui/icons/LoupeRounded" :default LoupeRounded]
            ["@material-ui/icons/LoupeSharp" :default LoupeSharp]
            ["@material-ui/icons/LoupeTwoTone" :default LoupeTwoTone]
            ["@material-ui/icons/LowPriority" :default LowPriority]
            ["@material-ui/icons/LowPriorityOutlined" :default LowPriorityOutlined]
            ["@material-ui/icons/LowPriorityRounded" :default LowPriorityRounded]
            ["@material-ui/icons/LowPrioritySharp" :default LowPrioritySharp]
            ["@material-ui/icons/LowPriorityTwoTone" :default LowPriorityTwoTone]
            ["@material-ui/icons/Loyalty" :default Loyalty]
            ["@material-ui/icons/LoyaltyOutlined" :default LoyaltyOutlined]
            ["@material-ui/icons/LoyaltyRounded" :default LoyaltyRounded]
            ["@material-ui/icons/LoyaltySharp" :default LoyaltySharp]
            ["@material-ui/icons/LoyaltyTwoTone" :default LoyaltyTwoTone]
            ["@material-ui/icons/Mail" :default Mail]
            ["@material-ui/icons/MailOutline" :default MailOutline]
            ["@material-ui/icons/MailOutlined" :default MailOutlined]
            ["@material-ui/icons/MailOutlineOutlined" :default MailOutlineOutlined]
            ["@material-ui/icons/MailOutlineRounded" :default MailOutlineRounded]
            ["@material-ui/icons/MailOutlineSharp" :default MailOutlineSharp]
            ["@material-ui/icons/MailOutlineTwoTone" :default MailOutlineTwoTone]
            ["@material-ui/icons/MailRounded" :default MailRounded]
            ["@material-ui/icons/MailSharp" :default MailSharp]
            ["@material-ui/icons/MailTwoTone" :default MailTwoTone]
            ["@material-ui/icons/Map" :default Map]
            ["@material-ui/icons/MapOutlined" :default MapOutlined]
            ["@material-ui/icons/MapRounded" :default MapRounded]
            ["@material-ui/icons/MapSharp" :default MapSharp]
            ["@material-ui/icons/MapTwoTone" :default MapTwoTone]
            ["@material-ui/icons/Markunread" :default Markunread]
            ["@material-ui/icons/MarkunreadMailbox" :default MarkunreadMailbox]
            ["@material-ui/icons/MarkunreadMailboxOutlined" :default MarkunreadMailboxOutlined]
            ["@material-ui/icons/MarkunreadMailboxRounded" :default MarkunreadMailboxRounded]
            ["@material-ui/icons/MarkunreadMailboxSharp" :default MarkunreadMailboxSharp]
            ["@material-ui/icons/MarkunreadMailboxTwoTone" :default MarkunreadMailboxTwoTone]
            ["@material-ui/icons/MarkunreadOutlined" :default MarkunreadOutlined]
            ["@material-ui/icons/MarkunreadRounded" :default MarkunreadRounded]
            ["@material-ui/icons/MarkunreadSharp" :default MarkunreadSharp]
            ["@material-ui/icons/MarkunreadTwoTone" :default MarkunreadTwoTone]
            ["@material-ui/icons/Maximize" :default Maximize]
            ["@material-ui/icons/MaximizeOutlined" :default MaximizeOutlined]
            ["@material-ui/icons/MaximizeRounded" :default MaximizeRounded]
            ["@material-ui/icons/MaximizeSharp" :default MaximizeSharp]
            ["@material-ui/icons/MaximizeTwoTone" :default MaximizeTwoTone]
            ["@material-ui/icons/MeetingRoom" :default MeetingRoom]
            ["@material-ui/icons/MeetingRoomOutlined" :default MeetingRoomOutlined]
            ["@material-ui/icons/MeetingRoomRounded" :default MeetingRoomRounded]
            ["@material-ui/icons/MeetingRoomSharp" :default MeetingRoomSharp]
            ["@material-ui/icons/MeetingRoomTwoTone" :default MeetingRoomTwoTone]
            ["@material-ui/icons/Memory" :default Memory]
            ["@material-ui/icons/MemoryOutlined" :default MemoryOutlined]
            ["@material-ui/icons/MemoryRounded" :default MemoryRounded]
            ["@material-ui/icons/MemorySharp" :default MemorySharp]
            ["@material-ui/icons/MemoryTwoTone" :default MemoryTwoTone]
            ["@material-ui/icons/Menu" :default Menu]
            ["@material-ui/icons/MenuBook" :default MenuBook]
            ["@material-ui/icons/MenuBookOutlined" :default MenuBookOutlined]
            ["@material-ui/icons/MenuBookRounded" :default MenuBookRounded]
            ["@material-ui/icons/MenuBookSharp" :default MenuBookSharp]
            ["@material-ui/icons/MenuBookTwoTone" :default MenuBookTwoTone]
            ["@material-ui/icons/MenuOpen" :default MenuOpen]
            ["@material-ui/icons/MenuOpenOutlined" :default MenuOpenOutlined]
            ["@material-ui/icons/MenuOpenRounded" :default MenuOpenRounded]
            ["@material-ui/icons/MenuOpenSharp" :default MenuOpenSharp]
            ["@material-ui/icons/MenuOpenTwoTone" :default MenuOpenTwoTone]
            ["@material-ui/icons/MenuOutlined" :default MenuOutlined]
            ["@material-ui/icons/MenuRounded" :default MenuRounded]
            ["@material-ui/icons/MenuSharp" :default MenuSharp]
            ["@material-ui/icons/MenuTwoTone" :default MenuTwoTone]
            ["@material-ui/icons/MergeType" :default MergeType]
            ["@material-ui/icons/MergeTypeOutlined" :default MergeTypeOutlined]
            ["@material-ui/icons/MergeTypeRounded" :default MergeTypeRounded]
            ["@material-ui/icons/MergeTypeSharp" :default MergeTypeSharp]
            ["@material-ui/icons/MergeTypeTwoTone" :default MergeTypeTwoTone]
            ["@material-ui/icons/Message" :default Message]
            ["@material-ui/icons/MessageOutlined" :default MessageOutlined]
            ["@material-ui/icons/MessageRounded" :default MessageRounded]
            ["@material-ui/icons/MessageSharp" :default MessageSharp]
            ["@material-ui/icons/MessageTwoTone" :default MessageTwoTone]
            ["@material-ui/icons/Mic" :default Mic]
            ["@material-ui/icons/MicNone" :default MicNone]
            ["@material-ui/icons/MicNoneOutlined" :default MicNoneOutlined]
            ["@material-ui/icons/MicNoneRounded" :default MicNoneRounded]
            ["@material-ui/icons/MicNoneSharp" :default MicNoneSharp]
            ["@material-ui/icons/MicNoneTwoTone" :default MicNoneTwoTone]
            ["@material-ui/icons/MicOff" :default MicOff]
            ["@material-ui/icons/MicOffOutlined" :default MicOffOutlined]
            ["@material-ui/icons/MicOffRounded" :default MicOffRounded]
            ["@material-ui/icons/MicOffSharp" :default MicOffSharp]
            ["@material-ui/icons/MicOffTwoTone" :default MicOffTwoTone]
            ["@material-ui/icons/MicOutlined" :default MicOutlined]
            ["@material-ui/icons/MicRounded" :default MicRounded]
            ["@material-ui/icons/MicSharp" :default MicSharp]
            ["@material-ui/icons/MicTwoTone" :default MicTwoTone]
            ["@material-ui/icons/Minimize" :default Minimize]
            ["@material-ui/icons/MinimizeOutlined" :default MinimizeOutlined]
            ["@material-ui/icons/MinimizeRounded" :default MinimizeRounded]
            ["@material-ui/icons/MinimizeSharp" :default MinimizeSharp]
            ["@material-ui/icons/MinimizeTwoTone" :default MinimizeTwoTone]
            ["@material-ui/icons/MissedVideoCall" :default MissedVideoCall]
            ["@material-ui/icons/MissedVideoCallOutlined" :default MissedVideoCallOutlined]
            ["@material-ui/icons/MissedVideoCallRounded" :default MissedVideoCallRounded]
            ["@material-ui/icons/MissedVideoCallSharp" :default MissedVideoCallSharp]
            ["@material-ui/icons/MissedVideoCallTwoTone" :default MissedVideoCallTwoTone]
            ["@material-ui/icons/Mms" :default Mms]
            ["@material-ui/icons/MmsOutlined" :default MmsOutlined]
            ["@material-ui/icons/MmsRounded" :default MmsRounded]
            ["@material-ui/icons/MmsSharp" :default MmsSharp]
            ["@material-ui/icons/MmsTwoTone" :default MmsTwoTone]
            ["@material-ui/icons/MobileFriendly" :default MobileFriendly]
            ["@material-ui/icons/MobileFriendlyOutlined" :default MobileFriendlyOutlined]
            ["@material-ui/icons/MobileFriendlyRounded" :default MobileFriendlyRounded]
            ["@material-ui/icons/MobileFriendlySharp" :default MobileFriendlySharp]
            ["@material-ui/icons/MobileFriendlyTwoTone" :default MobileFriendlyTwoTone]
            ["@material-ui/icons/MobileOff" :default MobileOff]
            ["@material-ui/icons/MobileOffOutlined" :default MobileOffOutlined]
            ["@material-ui/icons/MobileOffRounded" :default MobileOffRounded]
            ["@material-ui/icons/MobileOffSharp" :default MobileOffSharp]
            ["@material-ui/icons/MobileOffTwoTone" :default MobileOffTwoTone]
            ["@material-ui/icons/MobileScreenShare" :default MobileScreenShare]
            ["@material-ui/icons/MobileScreenShareOutlined" :default MobileScreenShareOutlined]
            ["@material-ui/icons/MobileScreenShareRounded" :default MobileScreenShareRounded]
            ["@material-ui/icons/MobileScreenShareSharp" :default MobileScreenShareSharp]
            ["@material-ui/icons/MobileScreenShareTwoTone" :default MobileScreenShareTwoTone]
            ["@material-ui/icons/ModeComment" :default ModeComment]
            ["@material-ui/icons/ModeCommentOutlined" :default ModeCommentOutlined]
            ["@material-ui/icons/ModeCommentRounded" :default ModeCommentRounded]
            ["@material-ui/icons/ModeCommentSharp" :default ModeCommentSharp]
            ["@material-ui/icons/ModeCommentTwoTone" :default ModeCommentTwoTone]
            ["@material-ui/icons/MonetizationOn" :default MonetizationOn]
            ["@material-ui/icons/MonetizationOnOutlined" :default MonetizationOnOutlined]
            ["@material-ui/icons/MonetizationOnRounded" :default MonetizationOnRounded]
            ["@material-ui/icons/MonetizationOnSharp" :default MonetizationOnSharp]
            ["@material-ui/icons/MonetizationOnTwoTone" :default MonetizationOnTwoTone]
            ["@material-ui/icons/Money" :default Money]
            ["@material-ui/icons/MoneyOff" :default MoneyOff]
            ["@material-ui/icons/MoneyOffOutlined" :default MoneyOffOutlined]
            ["@material-ui/icons/MoneyOffRounded" :default MoneyOffRounded]
            ["@material-ui/icons/MoneyOffSharp" :default MoneyOffSharp]
            ["@material-ui/icons/MoneyOffTwoTone" :default MoneyOffTwoTone]
            ["@material-ui/icons/MoneyOutlined" :default MoneyOutlined]
            ["@material-ui/icons/MoneyRounded" :default MoneyRounded]
            ["@material-ui/icons/MoneySharp" :default MoneySharp]
            ["@material-ui/icons/MoneyTwoTone" :default MoneyTwoTone]
            ["@material-ui/icons/MonochromePhotos" :default MonochromePhotos]
            ["@material-ui/icons/MonochromePhotosOutlined" :default MonochromePhotosOutlined]
            ["@material-ui/icons/MonochromePhotosRounded" :default MonochromePhotosRounded]
            ["@material-ui/icons/MonochromePhotosSharp" :default MonochromePhotosSharp]
            ["@material-ui/icons/MonochromePhotosTwoTone" :default MonochromePhotosTwoTone]
            ["@material-ui/icons/Mood" :default Mood]
            ["@material-ui/icons/MoodBad" :default MoodBad]
            ["@material-ui/icons/MoodBadOutlined" :default MoodBadOutlined]
            ["@material-ui/icons/MoodBadRounded" :default MoodBadRounded]
            ["@material-ui/icons/MoodBadSharp" :default MoodBadSharp]
            ["@material-ui/icons/MoodBadTwoTone" :default MoodBadTwoTone]
            ["@material-ui/icons/MoodOutlined" :default MoodOutlined]
            ["@material-ui/icons/MoodRounded" :default MoodRounded]
            ["@material-ui/icons/MoodSharp" :default MoodSharp]
            ["@material-ui/icons/MoodTwoTone" :default MoodTwoTone]
            ["@material-ui/icons/More" :default More]
            ["@material-ui/icons/MoreHoriz" :default MoreHoriz]
            ["@material-ui/icons/MoreHorizOutlined" :default MoreHorizOutlined]
            ["@material-ui/icons/MoreHorizRounded" :default MoreHorizRounded]
            ["@material-ui/icons/MoreHorizSharp" :default MoreHorizSharp]
            ["@material-ui/icons/MoreHorizTwoTone" :default MoreHorizTwoTone]
            ["@material-ui/icons/MoreOutlined" :default MoreOutlined]
            ["@material-ui/icons/MoreRounded" :default MoreRounded]
            ["@material-ui/icons/MoreSharp" :default MoreSharp]
            ["@material-ui/icons/MoreTwoTone" :default MoreTwoTone]
            ["@material-ui/icons/MoreVert" :default MoreVert]
            ["@material-ui/icons/MoreVertOutlined" :default MoreVertOutlined]
            ["@material-ui/icons/MoreVertRounded" :default MoreVertRounded]
            ["@material-ui/icons/MoreVertSharp" :default MoreVertSharp]
            ["@material-ui/icons/MoreVertTwoTone" :default MoreVertTwoTone]
            ["@material-ui/icons/Motorcycle" :default Motorcycle]
            ["@material-ui/icons/MotorcycleOutlined" :default MotorcycleOutlined]
            ["@material-ui/icons/MotorcycleRounded" :default MotorcycleRounded]
            ["@material-ui/icons/MotorcycleSharp" :default MotorcycleSharp]
            ["@material-ui/icons/MotorcycleTwoTone" :default MotorcycleTwoTone]
            ["@material-ui/icons/Mouse" :default Mouse]
            ["@material-ui/icons/MouseOutlined" :default MouseOutlined]
            ["@material-ui/icons/MouseRounded" :default MouseRounded]
            ["@material-ui/icons/MouseSharp" :default MouseSharp]
            ["@material-ui/icons/MouseTwoTone" :default MouseTwoTone]
            ["@material-ui/icons/MoveToInbox" :default MoveToInbox]
            ["@material-ui/icons/MoveToInboxOutlined" :default MoveToInboxOutlined]
            ["@material-ui/icons/MoveToInboxRounded" :default MoveToInboxRounded]
            ["@material-ui/icons/MoveToInboxSharp" :default MoveToInboxSharp]
            ["@material-ui/icons/MoveToInboxTwoTone" :default MoveToInboxTwoTone]
            ["@material-ui/icons/Movie" :default Movie]
            ["@material-ui/icons/MovieCreation" :default MovieCreation]
            ["@material-ui/icons/MovieCreationOutlined" :default MovieCreationOutlined]
            ["@material-ui/icons/MovieCreationRounded" :default MovieCreationRounded]
            ["@material-ui/icons/MovieCreationSharp" :default MovieCreationSharp]
            ["@material-ui/icons/MovieCreationTwoTone" :default MovieCreationTwoTone]
            ["@material-ui/icons/MovieFilter" :default MovieFilter]
            ["@material-ui/icons/MovieFilterOutlined" :default MovieFilterOutlined]
            ["@material-ui/icons/MovieFilterRounded" :default MovieFilterRounded]
            ["@material-ui/icons/MovieFilterSharp" :default MovieFilterSharp]
            ["@material-ui/icons/MovieFilterTwoTone" :default MovieFilterTwoTone]
            ["@material-ui/icons/MovieOutlined" :default MovieOutlined]
            ["@material-ui/icons/MovieRounded" :default MovieRounded]
            ["@material-ui/icons/MovieSharp" :default MovieSharp]
            ["@material-ui/icons/MovieTwoTone" :default MovieTwoTone]
            ["@material-ui/icons/MultilineChart" :default MultilineChart]
            ["@material-ui/icons/MultilineChartOutlined" :default MultilineChartOutlined]
            ["@material-ui/icons/MultilineChartRounded" :default MultilineChartRounded]
            ["@material-ui/icons/MultilineChartSharp" :default MultilineChartSharp]
            ["@material-ui/icons/MultilineChartTwoTone" :default MultilineChartTwoTone]
            ["@material-ui/icons/Museum" :default Museum]
            ["@material-ui/icons/MuseumOutlined" :default MuseumOutlined]
            ["@material-ui/icons/MuseumRounded" :default MuseumRounded]
            ["@material-ui/icons/MuseumSharp" :default MuseumSharp]
            ["@material-ui/icons/MuseumTwoTone" :default MuseumTwoTone]
            ["@material-ui/icons/MusicNote" :default MusicNote]
            ["@material-ui/icons/MusicNoteOutlined" :default MusicNoteOutlined]
            ["@material-ui/icons/MusicNoteRounded" :default MusicNoteRounded]
            ["@material-ui/icons/MusicNoteSharp" :default MusicNoteSharp]
            ["@material-ui/icons/MusicNoteTwoTone" :default MusicNoteTwoTone]
            ["@material-ui/icons/MusicOff" :default MusicOff]
            ["@material-ui/icons/MusicOffOutlined" :default MusicOffOutlined]
            ["@material-ui/icons/MusicOffRounded" :default MusicOffRounded]
            ["@material-ui/icons/MusicOffSharp" :default MusicOffSharp]
            ["@material-ui/icons/MusicOffTwoTone" :default MusicOffTwoTone]
            ["@material-ui/icons/MusicVideo" :default MusicVideo]
            ["@material-ui/icons/MusicVideoOutlined" :default MusicVideoOutlined]
            ["@material-ui/icons/MusicVideoRounded" :default MusicVideoRounded]
            ["@material-ui/icons/MusicVideoSharp" :default MusicVideoSharp]
            ["@material-ui/icons/MusicVideoTwoTone" :default MusicVideoTwoTone]
            ["@material-ui/icons/MyLocation" :default MyLocation]
            ["@material-ui/icons/MyLocationOutlined" :default MyLocationOutlined]
            ["@material-ui/icons/MyLocationRounded" :default MyLocationRounded]
            ["@material-ui/icons/MyLocationSharp" :default MyLocationSharp]
            ["@material-ui/icons/MyLocationTwoTone" :default MyLocationTwoTone]
            ["@material-ui/icons/Nature" :default Nature]
            ["@material-ui/icons/NatureOutlined" :default NatureOutlined]
            ["@material-ui/icons/NaturePeople" :default NaturePeople]
            ["@material-ui/icons/NaturePeopleOutlined" :default NaturePeopleOutlined]
            ["@material-ui/icons/NaturePeopleRounded" :default NaturePeopleRounded]
            ["@material-ui/icons/NaturePeopleSharp" :default NaturePeopleSharp]
            ["@material-ui/icons/NaturePeopleTwoTone" :default NaturePeopleTwoTone]
            ["@material-ui/icons/NatureRounded" :default NatureRounded]
            ["@material-ui/icons/NatureSharp" :default NatureSharp]
            ["@material-ui/icons/NatureTwoTone" :default NatureTwoTone]
            ["@material-ui/icons/NavigateBefore" :default NavigateBefore]
            ["@material-ui/icons/NavigateBeforeOutlined" :default NavigateBeforeOutlined]
            ["@material-ui/icons/NavigateBeforeRounded" :default NavigateBeforeRounded]
            ["@material-ui/icons/NavigateBeforeSharp" :default NavigateBeforeSharp]
            ["@material-ui/icons/NavigateBeforeTwoTone" :default NavigateBeforeTwoTone]
            ["@material-ui/icons/NavigateNext" :default NavigateNext]
            ["@material-ui/icons/NavigateNextOutlined" :default NavigateNextOutlined]
            ["@material-ui/icons/NavigateNextRounded" :default NavigateNextRounded]
            ["@material-ui/icons/NavigateNextSharp" :default NavigateNextSharp]
            ["@material-ui/icons/NavigateNextTwoTone" :default NavigateNextTwoTone]
            ["@material-ui/icons/Navigation" :default Navigation]
            ["@material-ui/icons/NavigationOutlined" :default NavigationOutlined]
            ["@material-ui/icons/NavigationRounded" :default NavigationRounded]
            ["@material-ui/icons/NavigationSharp" :default NavigationSharp]
            ["@material-ui/icons/NavigationTwoTone" :default NavigationTwoTone]
            ["@material-ui/icons/NearMe" :default NearMe]
            ["@material-ui/icons/NearMeOutlined" :default NearMeOutlined]
            ["@material-ui/icons/NearMeRounded" :default NearMeRounded]
            ["@material-ui/icons/NearMeSharp" :default NearMeSharp]
            ["@material-ui/icons/NearMeTwoTone" :default NearMeTwoTone]
            ["@material-ui/icons/NetworkCell" :default NetworkCell]
            ["@material-ui/icons/NetworkCellOutlined" :default NetworkCellOutlined]
            ["@material-ui/icons/NetworkCellRounded" :default NetworkCellRounded]
            ["@material-ui/icons/NetworkCellSharp" :default NetworkCellSharp]
            ["@material-ui/icons/NetworkCellTwoTone" :default NetworkCellTwoTone]
            ["@material-ui/icons/NetworkCheck" :default NetworkCheck]
            ["@material-ui/icons/NetworkCheckOutlined" :default NetworkCheckOutlined]
            ["@material-ui/icons/NetworkCheckRounded" :default NetworkCheckRounded]
            ["@material-ui/icons/NetworkCheckSharp" :default NetworkCheckSharp]
            ["@material-ui/icons/NetworkCheckTwoTone" :default NetworkCheckTwoTone]
            ["@material-ui/icons/NetworkLocked" :default NetworkLocked]
            ["@material-ui/icons/NetworkLockedOutlined" :default NetworkLockedOutlined]
            ["@material-ui/icons/NetworkLockedRounded" :default NetworkLockedRounded]
            ["@material-ui/icons/NetworkLockedSharp" :default NetworkLockedSharp]
            ["@material-ui/icons/NetworkLockedTwoTone" :default NetworkLockedTwoTone]
            ["@material-ui/icons/NetworkWifi" :default NetworkWifi]
            ["@material-ui/icons/NetworkWifiOutlined" :default NetworkWifiOutlined]
            ["@material-ui/icons/NetworkWifiRounded" :default NetworkWifiRounded]
            ["@material-ui/icons/NetworkWifiSharp" :default NetworkWifiSharp]
            ["@material-ui/icons/NetworkWifiTwoTone" :default NetworkWifiTwoTone]
            ["@material-ui/icons/NewReleases" :default NewReleases]
            ["@material-ui/icons/NewReleasesOutlined" :default NewReleasesOutlined]
            ["@material-ui/icons/NewReleasesRounded" :default NewReleasesRounded]
            ["@material-ui/icons/NewReleasesSharp" :default NewReleasesSharp]
            ["@material-ui/icons/NewReleasesTwoTone" :default NewReleasesTwoTone]
            ["@material-ui/icons/NextWeek" :default NextWeek]
            ["@material-ui/icons/NextWeekOutlined" :default NextWeekOutlined]
            ["@material-ui/icons/NextWeekRounded" :default NextWeekRounded]
            ["@material-ui/icons/NextWeekSharp" :default NextWeekSharp]
            ["@material-ui/icons/NextWeekTwoTone" :default NextWeekTwoTone]
            ["@material-ui/icons/Nfc" :default Nfc]
            ["@material-ui/icons/NfcOutlined" :default NfcOutlined]
            ["@material-ui/icons/NfcRounded" :default NfcRounded]
            ["@material-ui/icons/NfcSharp" :default NfcSharp]
            ["@material-ui/icons/NfcTwoTone" :default NfcTwoTone]
            ["@material-ui/icons/NightsStay" :default NightsStay]
            ["@material-ui/icons/NightsStayOutlined" :default NightsStayOutlined]
            ["@material-ui/icons/NightsStayRounded" :default NightsStayRounded]
            ["@material-ui/icons/NightsStaySharp" :default NightsStaySharp]
            ["@material-ui/icons/NightsStayTwoTone" :default NightsStayTwoTone]
            ["@material-ui/icons/NoEncryption" :default NoEncryption]
            ["@material-ui/icons/NoEncryptionOutlined" :default NoEncryptionOutlined]
            ["@material-ui/icons/NoEncryptionRounded" :default NoEncryptionRounded]
            ["@material-ui/icons/NoEncryptionSharp" :default NoEncryptionSharp]
            ["@material-ui/icons/NoEncryptionTwoTone" :default NoEncryptionTwoTone]
            ["@material-ui/icons/NoMeetingRoom" :default NoMeetingRoom]
            ["@material-ui/icons/NoMeetingRoomOutlined" :default NoMeetingRoomOutlined]
            ["@material-ui/icons/NoMeetingRoomRounded" :default NoMeetingRoomRounded]
            ["@material-ui/icons/NoMeetingRoomSharp" :default NoMeetingRoomSharp]
            ["@material-ui/icons/NoMeetingRoomTwoTone" :default NoMeetingRoomTwoTone]
            ["@material-ui/icons/NoSim" :default NoSim]
            ["@material-ui/icons/NoSimOutlined" :default NoSimOutlined]
            ["@material-ui/icons/NoSimRounded" :default NoSimRounded]
            ["@material-ui/icons/NoSimSharp" :default NoSimSharp]
            ["@material-ui/icons/NoSimTwoTone" :default NoSimTwoTone]
            ["@material-ui/icons/Note" :default Note]
            ["@material-ui/icons/NoteAdd" :default NoteAdd]
            ["@material-ui/icons/NoteAddOutlined" :default NoteAddOutlined]
            ["@material-ui/icons/NoteAddRounded" :default NoteAddRounded]
            ["@material-ui/icons/NoteAddSharp" :default NoteAddSharp]
            ["@material-ui/icons/NoteAddTwoTone" :default NoteAddTwoTone]
            ["@material-ui/icons/NoteOutlined" :default NoteOutlined]
            ["@material-ui/icons/NoteRounded" :default NoteRounded]
            ["@material-ui/icons/Notes" :default Notes]
            ["@material-ui/icons/NoteSharp" :default NoteSharp]
            ["@material-ui/icons/NotesOutlined" :default NotesOutlined]
            ["@material-ui/icons/NotesRounded" :default NotesRounded]
            ["@material-ui/icons/NotesSharp" :default NotesSharp]
            ["@material-ui/icons/NotesTwoTone" :default NotesTwoTone]
            ["@material-ui/icons/NoteTwoTone" :default NoteTwoTone]
            ["@material-ui/icons/NotificationImportant" :default NotificationImportant]
            ["@material-ui/icons/NotificationImportantOutlined" :default NotificationImportantOutlined]
            ["@material-ui/icons/NotificationImportantRounded" :default NotificationImportantRounded]
            ["@material-ui/icons/NotificationImportantSharp" :default NotificationImportantSharp]
            ["@material-ui/icons/NotificationImportantTwoTone" :default NotificationImportantTwoTone]
            ["@material-ui/icons/Notifications" :default Notifications]
            ["@material-ui/icons/NotificationsActive" :default NotificationsActive]
            ["@material-ui/icons/NotificationsActiveOutlined" :default NotificationsActiveOutlined]
            ["@material-ui/icons/NotificationsActiveRounded" :default NotificationsActiveRounded]
            ["@material-ui/icons/NotificationsActiveSharp" :default NotificationsActiveSharp]
            ["@material-ui/icons/NotificationsActiveTwoTone" :default NotificationsActiveTwoTone]
            ["@material-ui/icons/NotificationsNone" :default NotificationsNone]
            ["@material-ui/icons/NotificationsNoneOutlined" :default NotificationsNoneOutlined]
            ["@material-ui/icons/NotificationsNoneRounded" :default NotificationsNoneRounded]
            ["@material-ui/icons/NotificationsNoneSharp" :default NotificationsNoneSharp]
            ["@material-ui/icons/NotificationsNoneTwoTone" :default NotificationsNoneTwoTone]
            ["@material-ui/icons/NotificationsOff" :default NotificationsOff]
            ["@material-ui/icons/NotificationsOffOutlined" :default NotificationsOffOutlined]
            ["@material-ui/icons/NotificationsOffRounded" :default NotificationsOffRounded]
            ["@material-ui/icons/NotificationsOffSharp" :default NotificationsOffSharp]
            ["@material-ui/icons/NotificationsOffTwoTone" :default NotificationsOffTwoTone]
            ["@material-ui/icons/NotificationsOutlined" :default NotificationsOutlined]
            ["@material-ui/icons/NotificationsPaused" :default NotificationsPaused]
            ["@material-ui/icons/NotificationsPausedOutlined" :default NotificationsPausedOutlined]
            ["@material-ui/icons/NotificationsPausedRounded" :default NotificationsPausedRounded]
            ["@material-ui/icons/NotificationsPausedSharp" :default NotificationsPausedSharp]
            ["@material-ui/icons/NotificationsPausedTwoTone" :default NotificationsPausedTwoTone]
            ["@material-ui/icons/NotificationsRounded" :default NotificationsRounded]
            ["@material-ui/icons/NotificationsSharp" :default NotificationsSharp]
            ["@material-ui/icons/NotificationsTwoTone" :default NotificationsTwoTone]
            ["@material-ui/icons/NotInterested" :default NotInterested]
            ["@material-ui/icons/NotInterestedOutlined" :default NotInterestedOutlined]
            ["@material-ui/icons/NotInterestedRounded" :default NotInterestedRounded]
            ["@material-ui/icons/NotInterestedSharp" :default NotInterestedSharp]
            ["@material-ui/icons/NotInterestedTwoTone" :default NotInterestedTwoTone]
            ["@material-ui/icons/NotListedLocation" :default NotListedLocation]
            ["@material-ui/icons/NotListedLocationOutlined" :default NotListedLocationOutlined]
            ["@material-ui/icons/NotListedLocationRounded" :default NotListedLocationRounded]
            ["@material-ui/icons/NotListedLocationSharp" :default NotListedLocationSharp]
            ["@material-ui/icons/NotListedLocationTwoTone" :default NotListedLocationTwoTone]
            ["@material-ui/icons/OfflineBolt" :default OfflineBolt]
            ["@material-ui/icons/OfflineBoltOutlined" :default OfflineBoltOutlined]
            ["@material-ui/icons/OfflineBoltRounded" :default OfflineBoltRounded]
            ["@material-ui/icons/OfflineBoltSharp" :default OfflineBoltSharp]
            ["@material-ui/icons/OfflineBoltTwoTone" :default OfflineBoltTwoTone]
            ["@material-ui/icons/OfflinePin" :default OfflinePin]
            ["@material-ui/icons/OfflinePinOutlined" :default OfflinePinOutlined]
            ["@material-ui/icons/OfflinePinRounded" :default OfflinePinRounded]
            ["@material-ui/icons/OfflinePinSharp" :default OfflinePinSharp]
            ["@material-ui/icons/OfflinePinTwoTone" :default OfflinePinTwoTone]
            ["@material-ui/icons/OndemandVideo" :default OndemandVideo]
            ["@material-ui/icons/OndemandVideoOutlined" :default OndemandVideoOutlined]
            ["@material-ui/icons/OndemandVideoRounded" :default OndemandVideoRounded]
            ["@material-ui/icons/OndemandVideoSharp" :default OndemandVideoSharp]
            ["@material-ui/icons/OndemandVideoTwoTone" :default OndemandVideoTwoTone]
            ["@material-ui/icons/Opacity" :default Opacity]
            ["@material-ui/icons/OpacityOutlined" :default OpacityOutlined]
            ["@material-ui/icons/OpacityRounded" :default OpacityRounded]
            ["@material-ui/icons/OpacitySharp" :default OpacitySharp]
            ["@material-ui/icons/OpacityTwoTone" :default OpacityTwoTone]
            ["@material-ui/icons/OpenInBrowser" :default OpenInBrowser]
            ["@material-ui/icons/OpenInBrowserOutlined" :default OpenInBrowserOutlined]
            ["@material-ui/icons/OpenInBrowserRounded" :default OpenInBrowserRounded]
            ["@material-ui/icons/OpenInBrowserSharp" :default OpenInBrowserSharp]
            ["@material-ui/icons/OpenInBrowserTwoTone" :default OpenInBrowserTwoTone]
            ["@material-ui/icons/OpenInNew" :default OpenInNew]
            ["@material-ui/icons/OpenInNewOutlined" :default OpenInNewOutlined]
            ["@material-ui/icons/OpenInNewRounded" :default OpenInNewRounded]
            ["@material-ui/icons/OpenInNewSharp" :default OpenInNewSharp]
            ["@material-ui/icons/OpenInNewTwoTone" :default OpenInNewTwoTone]
            ["@material-ui/icons/OpenWith" :default OpenWith]
            ["@material-ui/icons/OpenWithOutlined" :default OpenWithOutlined]
            ["@material-ui/icons/OpenWithRounded" :default OpenWithRounded]
            ["@material-ui/icons/OpenWithSharp" :default OpenWithSharp]
            ["@material-ui/icons/OpenWithTwoTone" :default OpenWithTwoTone]
            ["@material-ui/icons/OutdoorGrill" :default OutdoorGrill]
            ["@material-ui/icons/OutdoorGrillOutlined" :default OutdoorGrillOutlined]
            ["@material-ui/icons/OutdoorGrillRounded" :default OutdoorGrillRounded]
            ["@material-ui/icons/OutdoorGrillSharp" :default OutdoorGrillSharp]
            ["@material-ui/icons/OutdoorGrillTwoTone" :default OutdoorGrillTwoTone]
            ["@material-ui/icons/OutlinedFlag" :default OutlinedFlag]
            ["@material-ui/icons/OutlinedFlagOutlined" :default OutlinedFlagOutlined]
            ["@material-ui/icons/OutlinedFlagRounded" :default OutlinedFlagRounded]
            ["@material-ui/icons/OutlinedFlagSharp" :default OutlinedFlagSharp]
            ["@material-ui/icons/OutlinedFlagTwoTone" :default OutlinedFlagTwoTone]
            ["@material-ui/icons/Pages" :default Pages]
            ["@material-ui/icons/PagesOutlined" :default PagesOutlined]
            ["@material-ui/icons/PagesRounded" :default PagesRounded]
            ["@material-ui/icons/PagesSharp" :default PagesSharp]
            ["@material-ui/icons/PagesTwoTone" :default PagesTwoTone]
            ["@material-ui/icons/Pageview" :default Pageview]
            ["@material-ui/icons/PageviewOutlined" :default PageviewOutlined]
            ["@material-ui/icons/PageviewRounded" :default PageviewRounded]
            ["@material-ui/icons/PageviewSharp" :default PageviewSharp]
            ["@material-ui/icons/PageviewTwoTone" :default PageviewTwoTone]
            ["@material-ui/icons/Palette" :default Palette]
            ["@material-ui/icons/PaletteOutlined" :default PaletteOutlined]
            ["@material-ui/icons/PaletteRounded" :default PaletteRounded]
            ["@material-ui/icons/PaletteSharp" :default PaletteSharp]
            ["@material-ui/icons/PaletteTwoTone" :default PaletteTwoTone]
            ["@material-ui/icons/Panorama" :default Panorama]
            ["@material-ui/icons/PanoramaFishEye" :default PanoramaFishEye]
            ["@material-ui/icons/PanoramaFishEyeOutlined" :default PanoramaFishEyeOutlined]
            ["@material-ui/icons/PanoramaFishEyeRounded" :default PanoramaFishEyeRounded]
            ["@material-ui/icons/PanoramaFishEyeSharp" :default PanoramaFishEyeSharp]
            ["@material-ui/icons/PanoramaFishEyeTwoTone" :default PanoramaFishEyeTwoTone]
            ["@material-ui/icons/PanoramaHorizontal" :default PanoramaHorizontal]
            ["@material-ui/icons/PanoramaHorizontalOutlined" :default PanoramaHorizontalOutlined]
            ["@material-ui/icons/PanoramaHorizontalRounded" :default PanoramaHorizontalRounded]
            ["@material-ui/icons/PanoramaHorizontalSharp" :default PanoramaHorizontalSharp]
            ["@material-ui/icons/PanoramaHorizontalTwoTone" :default PanoramaHorizontalTwoTone]
            ["@material-ui/icons/PanoramaOutlined" :default PanoramaOutlined]
            ["@material-ui/icons/PanoramaRounded" :default PanoramaRounded]
            ["@material-ui/icons/PanoramaSharp" :default PanoramaSharp]
            ["@material-ui/icons/PanoramaTwoTone" :default PanoramaTwoTone]
            ["@material-ui/icons/PanoramaVertical" :default PanoramaVertical]
            ["@material-ui/icons/PanoramaVerticalOutlined" :default PanoramaVerticalOutlined]
            ["@material-ui/icons/PanoramaVerticalRounded" :default PanoramaVerticalRounded]
            ["@material-ui/icons/PanoramaVerticalSharp" :default PanoramaVerticalSharp]
            ["@material-ui/icons/PanoramaVerticalTwoTone" :default PanoramaVerticalTwoTone]
            ["@material-ui/icons/PanoramaWideAngle" :default PanoramaWideAngle]
            ["@material-ui/icons/PanoramaWideAngleOutlined" :default PanoramaWideAngleOutlined]
            ["@material-ui/icons/PanoramaWideAngleRounded" :default PanoramaWideAngleRounded]
            ["@material-ui/icons/PanoramaWideAngleSharp" :default PanoramaWideAngleSharp]
            ["@material-ui/icons/PanoramaWideAngleTwoTone" :default PanoramaWideAngleTwoTone]
            ["@material-ui/icons/PanTool" :default PanTool]
            ["@material-ui/icons/PanToolOutlined" :default PanToolOutlined]
            ["@material-ui/icons/PanToolRounded" :default PanToolRounded]
            ["@material-ui/icons/PanToolSharp" :default PanToolSharp]
            ["@material-ui/icons/PanToolTwoTone" :default PanToolTwoTone]
            ["@material-ui/icons/PartyMode" :default PartyMode]
            ["@material-ui/icons/PartyModeOutlined" :default PartyModeOutlined]
            ["@material-ui/icons/PartyModeRounded" :default PartyModeRounded]
            ["@material-ui/icons/PartyModeSharp" :default PartyModeSharp]
            ["@material-ui/icons/PartyModeTwoTone" :default PartyModeTwoTone]
            ["@material-ui/icons/Pause" :default Pause]
            ["@material-ui/icons/PauseCircleFilled" :default PauseCircleFilled]
            ["@material-ui/icons/PauseCircleFilledOutlined" :default PauseCircleFilledOutlined]
            ["@material-ui/icons/PauseCircleFilledRounded" :default PauseCircleFilledRounded]
            ["@material-ui/icons/PauseCircleFilledSharp" :default PauseCircleFilledSharp]
            ["@material-ui/icons/PauseCircleFilledTwoTone" :default PauseCircleFilledTwoTone]
            ["@material-ui/icons/PauseCircleOutline" :default PauseCircleOutline]
            ["@material-ui/icons/PauseCircleOutlineOutlined" :default PauseCircleOutlineOutlined]
            ["@material-ui/icons/PauseCircleOutlineRounded" :default PauseCircleOutlineRounded]
            ["@material-ui/icons/PauseCircleOutlineSharp" :default PauseCircleOutlineSharp]
            ["@material-ui/icons/PauseCircleOutlineTwoTone" :default PauseCircleOutlineTwoTone]
            ["@material-ui/icons/PauseOutlined" :default PauseOutlined]
            ["@material-ui/icons/PausePresentation" :default PausePresentation]
            ["@material-ui/icons/PausePresentationOutlined" :default PausePresentationOutlined]
            ["@material-ui/icons/PausePresentationRounded" :default PausePresentationRounded]
            ["@material-ui/icons/PausePresentationSharp" :default PausePresentationSharp]
            ["@material-ui/icons/PausePresentationTwoTone" :default PausePresentationTwoTone]
            ["@material-ui/icons/PauseRounded" :default PauseRounded]
            ["@material-ui/icons/PauseSharp" :default PauseSharp]
            ["@material-ui/icons/PauseTwoTone" :default PauseTwoTone]
            ["@material-ui/icons/Payment" :default Payment]
            ["@material-ui/icons/PaymentOutlined" :default PaymentOutlined]
            ["@material-ui/icons/PaymentRounded" :default PaymentRounded]
            ["@material-ui/icons/PaymentSharp" :default PaymentSharp]
            ["@material-ui/icons/PaymentTwoTone" :default PaymentTwoTone]
            ["@material-ui/icons/People" :default People]
            ["@material-ui/icons/PeopleAlt" :default PeopleAlt]
            ["@material-ui/icons/PeopleAltOutlined" :default PeopleAltOutlined]
            ["@material-ui/icons/PeopleAltRounded" :default PeopleAltRounded]
            ["@material-ui/icons/PeopleAltSharp" :default PeopleAltSharp]
            ["@material-ui/icons/PeopleAltTwoTone" :default PeopleAltTwoTone]
            ["@material-ui/icons/PeopleOutline" :default PeopleOutline]
            ["@material-ui/icons/PeopleOutlined" :default PeopleOutlined]
            ["@material-ui/icons/PeopleOutlineOutlined" :default PeopleOutlineOutlined]
            ["@material-ui/icons/PeopleOutlineRounded" :default PeopleOutlineRounded]
            ["@material-ui/icons/PeopleOutlineSharp" :default PeopleOutlineSharp]
            ["@material-ui/icons/PeopleOutlineTwoTone" :default PeopleOutlineTwoTone]
            ["@material-ui/icons/PeopleRounded" :default PeopleRounded]
            ["@material-ui/icons/PeopleSharp" :default PeopleSharp]
            ["@material-ui/icons/PeopleTwoTone" :default PeopleTwoTone]
            ["@material-ui/icons/PermCameraMic" :default PermCameraMic]
            ["@material-ui/icons/PermCameraMicOutlined" :default PermCameraMicOutlined]
            ["@material-ui/icons/PermCameraMicRounded" :default PermCameraMicRounded]
            ["@material-ui/icons/PermCameraMicSharp" :default PermCameraMicSharp]
            ["@material-ui/icons/PermCameraMicTwoTone" :default PermCameraMicTwoTone]
            ["@material-ui/icons/PermContactCalendar" :default PermContactCalendar]
            ["@material-ui/icons/PermContactCalendarOutlined" :default PermContactCalendarOutlined]
            ["@material-ui/icons/PermContactCalendarRounded" :default PermContactCalendarRounded]
            ["@material-ui/icons/PermContactCalendarSharp" :default PermContactCalendarSharp]
            ["@material-ui/icons/PermContactCalendarTwoTone" :default PermContactCalendarTwoTone]
            ["@material-ui/icons/PermDataSetting" :default PermDataSetting]
            ["@material-ui/icons/PermDataSettingOutlined" :default PermDataSettingOutlined]
            ["@material-ui/icons/PermDataSettingRounded" :default PermDataSettingRounded]
            ["@material-ui/icons/PermDataSettingSharp" :default PermDataSettingSharp]
            ["@material-ui/icons/PermDataSettingTwoTone" :default PermDataSettingTwoTone]
            ["@material-ui/icons/PermDeviceInformation" :default PermDeviceInformation]
            ["@material-ui/icons/PermDeviceInformationOutlined" :default PermDeviceInformationOutlined]
            ["@material-ui/icons/PermDeviceInformationRounded" :default PermDeviceInformationRounded]
            ["@material-ui/icons/PermDeviceInformationSharp" :default PermDeviceInformationSharp]
            ["@material-ui/icons/PermDeviceInformationTwoTone" :default PermDeviceInformationTwoTone]
            ["@material-ui/icons/PermIdentity" :default PermIdentity]
            ["@material-ui/icons/PermIdentityOutlined" :default PermIdentityOutlined]
            ["@material-ui/icons/PermIdentityRounded" :default PermIdentityRounded]
            ["@material-ui/icons/PermIdentitySharp" :default PermIdentitySharp]
            ["@material-ui/icons/PermIdentityTwoTone" :default PermIdentityTwoTone]
            ["@material-ui/icons/PermMedia" :default PermMedia]
            ["@material-ui/icons/PermMediaOutlined" :default PermMediaOutlined]
            ["@material-ui/icons/PermMediaRounded" :default PermMediaRounded]
            ["@material-ui/icons/PermMediaSharp" :default PermMediaSharp]
            ["@material-ui/icons/PermMediaTwoTone" :default PermMediaTwoTone]
            ["@material-ui/icons/PermPhoneMsg" :default PermPhoneMsg]
            ["@material-ui/icons/PermPhoneMsgOutlined" :default PermPhoneMsgOutlined]
            ["@material-ui/icons/PermPhoneMsgRounded" :default PermPhoneMsgRounded]
            ["@material-ui/icons/PermPhoneMsgSharp" :default PermPhoneMsgSharp]
            ["@material-ui/icons/PermPhoneMsgTwoTone" :default PermPhoneMsgTwoTone]
            ["@material-ui/icons/PermScanWifi" :default PermScanWifi]
            ["@material-ui/icons/PermScanWifiOutlined" :default PermScanWifiOutlined]
            ["@material-ui/icons/PermScanWifiRounded" :default PermScanWifiRounded]
            ["@material-ui/icons/PermScanWifiSharp" :default PermScanWifiSharp]
            ["@material-ui/icons/PermScanWifiTwoTone" :default PermScanWifiTwoTone]
            ["@material-ui/icons/Person" :default Person]
            ["@material-ui/icons/PersonAdd" :default PersonAdd]
            ["@material-ui/icons/PersonAddDisabled" :default PersonAddDisabled]
            ["@material-ui/icons/PersonAddDisabledOutlined" :default PersonAddDisabledOutlined]
            ["@material-ui/icons/PersonAddDisabledRounded" :default PersonAddDisabledRounded]
            ["@material-ui/icons/PersonAddDisabledSharp" :default PersonAddDisabledSharp]
            ["@material-ui/icons/PersonAddDisabledTwoTone" :default PersonAddDisabledTwoTone]
            ["@material-ui/icons/PersonAddOutlined" :default PersonAddOutlined]
            ["@material-ui/icons/PersonAddRounded" :default PersonAddRounded]
            ["@material-ui/icons/PersonAddSharp" :default PersonAddSharp]
            ["@material-ui/icons/PersonAddTwoTone" :default PersonAddTwoTone]
            ["@material-ui/icons/PersonalVideo" :default PersonalVideo]
            ["@material-ui/icons/PersonalVideoOutlined" :default PersonalVideoOutlined]
            ["@material-ui/icons/PersonalVideoRounded" :default PersonalVideoRounded]
            ["@material-ui/icons/PersonalVideoSharp" :default PersonalVideoSharp]
            ["@material-ui/icons/PersonalVideoTwoTone" :default PersonalVideoTwoTone]
            ["@material-ui/icons/PersonOutline" :default PersonOutline]
            ["@material-ui/icons/PersonOutlined" :default PersonOutlined]
            ["@material-ui/icons/PersonOutlineOutlined" :default PersonOutlineOutlined]
            ["@material-ui/icons/PersonOutlineRounded" :default PersonOutlineRounded]
            ["@material-ui/icons/PersonOutlineSharp" :default PersonOutlineSharp]
            ["@material-ui/icons/PersonOutlineTwoTone" :default PersonOutlineTwoTone]
            ["@material-ui/icons/PersonPin" :default PersonPin]
            ["@material-ui/icons/PersonPinCircle" :default PersonPinCircle]
            ["@material-ui/icons/PersonPinCircleOutlined" :default PersonPinCircleOutlined]
            ["@material-ui/icons/PersonPinCircleRounded" :default PersonPinCircleRounded]
            ["@material-ui/icons/PersonPinCircleSharp" :default PersonPinCircleSharp]
            ["@material-ui/icons/PersonPinCircleTwoTone" :default PersonPinCircleTwoTone]
            ["@material-ui/icons/PersonPinOutlined" :default PersonPinOutlined]
            ["@material-ui/icons/PersonPinRounded" :default PersonPinRounded]
            ["@material-ui/icons/PersonPinSharp" :default PersonPinSharp]
            ["@material-ui/icons/PersonPinTwoTone" :default PersonPinTwoTone]
            ["@material-ui/icons/PersonRounded" :default PersonRounded]
            ["@material-ui/icons/PersonSharp" :default PersonSharp]
            ["@material-ui/icons/PersonTwoTone" :default PersonTwoTone]
            ["@material-ui/icons/Pets" :default Pets]
            ["@material-ui/icons/PetsOutlined" :default PetsOutlined]
            ["@material-ui/icons/PetsRounded" :default PetsRounded]
            ["@material-ui/icons/PetsSharp" :default PetsSharp]
            ["@material-ui/icons/PetsTwoTone" :default PetsTwoTone]
            ["@material-ui/icons/Phone" :default Phone]
            ["@material-ui/icons/PhoneAndroid" :default PhoneAndroid]
            ["@material-ui/icons/PhoneAndroidOutlined" :default PhoneAndroidOutlined]
            ["@material-ui/icons/PhoneAndroidRounded" :default PhoneAndroidRounded]
            ["@material-ui/icons/PhoneAndroidSharp" :default PhoneAndroidSharp]
            ["@material-ui/icons/PhoneAndroidTwoTone" :default PhoneAndroidTwoTone]
            ["@material-ui/icons/PhoneBluetoothSpeaker" :default PhoneBluetoothSpeaker]
            ["@material-ui/icons/PhoneBluetoothSpeakerOutlined" :default PhoneBluetoothSpeakerOutlined]
            ["@material-ui/icons/PhoneBluetoothSpeakerRounded" :default PhoneBluetoothSpeakerRounded]
            ["@material-ui/icons/PhoneBluetoothSpeakerSharp" :default PhoneBluetoothSpeakerSharp]
            ["@material-ui/icons/PhoneBluetoothSpeakerTwoTone" :default PhoneBluetoothSpeakerTwoTone]
            ["@material-ui/icons/PhoneCallback" :default PhoneCallback]
            ["@material-ui/icons/PhoneCallbackOutlined" :default PhoneCallbackOutlined]
            ["@material-ui/icons/PhoneCallbackRounded" :default PhoneCallbackRounded]
            ["@material-ui/icons/PhoneCallbackSharp" :default PhoneCallbackSharp]
            ["@material-ui/icons/PhoneCallbackTwoTone" :default PhoneCallbackTwoTone]
            ["@material-ui/icons/PhoneDisabled" :default PhoneDisabled]
            ["@material-ui/icons/PhoneDisabledOutlined" :default PhoneDisabledOutlined]
            ["@material-ui/icons/PhoneDisabledRounded" :default PhoneDisabledRounded]
            ["@material-ui/icons/PhoneDisabledSharp" :default PhoneDisabledSharp]
            ["@material-ui/icons/PhoneDisabledTwoTone" :default PhoneDisabledTwoTone]
            ["@material-ui/icons/PhoneEnabled" :default PhoneEnabled]
            ["@material-ui/icons/PhoneEnabledOutlined" :default PhoneEnabledOutlined]
            ["@material-ui/icons/PhoneEnabledRounded" :default PhoneEnabledRounded]
            ["@material-ui/icons/PhoneEnabledSharp" :default PhoneEnabledSharp]
            ["@material-ui/icons/PhoneEnabledTwoTone" :default PhoneEnabledTwoTone]
            ["@material-ui/icons/PhoneForwarded" :default PhoneForwarded]
            ["@material-ui/icons/PhoneForwardedOutlined" :default PhoneForwardedOutlined]
            ["@material-ui/icons/PhoneForwardedRounded" :default PhoneForwardedRounded]
            ["@material-ui/icons/PhoneForwardedSharp" :default PhoneForwardedSharp]
            ["@material-ui/icons/PhoneForwardedTwoTone" :default PhoneForwardedTwoTone]
            ["@material-ui/icons/PhoneInTalk" :default PhoneInTalk]
            ["@material-ui/icons/PhoneInTalkOutlined" :default PhoneInTalkOutlined]
            ["@material-ui/icons/PhoneInTalkRounded" :default PhoneInTalkRounded]
            ["@material-ui/icons/PhoneInTalkSharp" :default PhoneInTalkSharp]
            ["@material-ui/icons/PhoneInTalkTwoTone" :default PhoneInTalkTwoTone]
            ["@material-ui/icons/PhoneIphone" :default PhoneIphone]
            ["@material-ui/icons/PhoneIphoneOutlined" :default PhoneIphoneOutlined]
            ["@material-ui/icons/PhoneIphoneRounded" :default PhoneIphoneRounded]
            ["@material-ui/icons/PhoneIphoneSharp" :default PhoneIphoneSharp]
            ["@material-ui/icons/PhoneIphoneTwoTone" :default PhoneIphoneTwoTone]
            ["@material-ui/icons/Phonelink" :default Phonelink]
            ["@material-ui/icons/PhonelinkErase" :default PhonelinkErase]
            ["@material-ui/icons/PhonelinkEraseOutlined" :default PhonelinkEraseOutlined]
            ["@material-ui/icons/PhonelinkEraseRounded" :default PhonelinkEraseRounded]
            ["@material-ui/icons/PhonelinkEraseSharp" :default PhonelinkEraseSharp]
            ["@material-ui/icons/PhonelinkEraseTwoTone" :default PhonelinkEraseTwoTone]
            ["@material-ui/icons/PhonelinkLock" :default PhonelinkLock]
            ["@material-ui/icons/PhonelinkLockOutlined" :default PhonelinkLockOutlined]
            ["@material-ui/icons/PhonelinkLockRounded" :default PhonelinkLockRounded]
            ["@material-ui/icons/PhonelinkLockSharp" :default PhonelinkLockSharp]
            ["@material-ui/icons/PhonelinkLockTwoTone" :default PhonelinkLockTwoTone]
            ["@material-ui/icons/PhonelinkOff" :default PhonelinkOff]
            ["@material-ui/icons/PhonelinkOffOutlined" :default PhonelinkOffOutlined]
            ["@material-ui/icons/PhonelinkOffRounded" :default PhonelinkOffRounded]
            ["@material-ui/icons/PhonelinkOffSharp" :default PhonelinkOffSharp]
            ["@material-ui/icons/PhonelinkOffTwoTone" :default PhonelinkOffTwoTone]
            ["@material-ui/icons/PhonelinkOutlined" :default PhonelinkOutlined]
            ["@material-ui/icons/PhonelinkRing" :default PhonelinkRing]
            ["@material-ui/icons/PhonelinkRingOutlined" :default PhonelinkRingOutlined]
            ["@material-ui/icons/PhonelinkRingRounded" :default PhonelinkRingRounded]
            ["@material-ui/icons/PhonelinkRingSharp" :default PhonelinkRingSharp]
            ["@material-ui/icons/PhonelinkRingTwoTone" :default PhonelinkRingTwoTone]
            ["@material-ui/icons/PhonelinkRounded" :default PhonelinkRounded]
            ["@material-ui/icons/PhonelinkSetup" :default PhonelinkSetup]
            ["@material-ui/icons/PhonelinkSetupOutlined" :default PhonelinkSetupOutlined]
            ["@material-ui/icons/PhonelinkSetupRounded" :default PhonelinkSetupRounded]
            ["@material-ui/icons/PhonelinkSetupSharp" :default PhonelinkSetupSharp]
            ["@material-ui/icons/PhonelinkSetupTwoTone" :default PhonelinkSetupTwoTone]
            ["@material-ui/icons/PhonelinkSharp" :default PhonelinkSharp]
            ["@material-ui/icons/PhonelinkTwoTone" :default PhonelinkTwoTone]
            ["@material-ui/icons/PhoneLocked" :default PhoneLocked]
            ["@material-ui/icons/PhoneLockedOutlined" :default PhoneLockedOutlined]
            ["@material-ui/icons/PhoneLockedRounded" :default PhoneLockedRounded]
            ["@material-ui/icons/PhoneLockedSharp" :default PhoneLockedSharp]
            ["@material-ui/icons/PhoneLockedTwoTone" :default PhoneLockedTwoTone]
            ["@material-ui/icons/PhoneMissed" :default PhoneMissed]
            ["@material-ui/icons/PhoneMissedOutlined" :default PhoneMissedOutlined]
            ["@material-ui/icons/PhoneMissedRounded" :default PhoneMissedRounded]
            ["@material-ui/icons/PhoneMissedSharp" :default PhoneMissedSharp]
            ["@material-ui/icons/PhoneMissedTwoTone" :default PhoneMissedTwoTone]
            ["@material-ui/icons/PhoneOutlined" :default PhoneOutlined]
            ["@material-ui/icons/PhonePaused" :default PhonePaused]
            ["@material-ui/icons/PhonePausedOutlined" :default PhonePausedOutlined]
            ["@material-ui/icons/PhonePausedRounded" :default PhonePausedRounded]
            ["@material-ui/icons/PhonePausedSharp" :default PhonePausedSharp]
            ["@material-ui/icons/PhonePausedTwoTone" :default PhonePausedTwoTone]
            ["@material-ui/icons/PhoneRounded" :default PhoneRounded]
            ["@material-ui/icons/PhoneSharp" :default PhoneSharp]
            ["@material-ui/icons/PhoneTwoTone" :default PhoneTwoTone]
            ["@material-ui/icons/Photo" :default Photo]
            ["@material-ui/icons/PhotoAlbum" :default PhotoAlbum]
            ["@material-ui/icons/PhotoAlbumOutlined" :default PhotoAlbumOutlined]
            ["@material-ui/icons/PhotoAlbumRounded" :default PhotoAlbumRounded]
            ["@material-ui/icons/PhotoAlbumSharp" :default PhotoAlbumSharp]
            ["@material-ui/icons/PhotoAlbumTwoTone" :default PhotoAlbumTwoTone]
            ["@material-ui/icons/PhotoCamera" :default PhotoCamera]
            ["@material-ui/icons/PhotoCameraOutlined" :default PhotoCameraOutlined]
            ["@material-ui/icons/PhotoCameraRounded" :default PhotoCameraRounded]
            ["@material-ui/icons/PhotoCameraSharp" :default PhotoCameraSharp]
            ["@material-ui/icons/PhotoCameraTwoTone" :default PhotoCameraTwoTone]
            ["@material-ui/icons/PhotoFilter" :default PhotoFilter]
            ["@material-ui/icons/PhotoFilterOutlined" :default PhotoFilterOutlined]
            ["@material-ui/icons/PhotoFilterRounded" :default PhotoFilterRounded]
            ["@material-ui/icons/PhotoFilterSharp" :default PhotoFilterSharp]
            ["@material-ui/icons/PhotoFilterTwoTone" :default PhotoFilterTwoTone]
            ["@material-ui/icons/PhotoLibrary" :default PhotoLibrary]
            ["@material-ui/icons/PhotoLibraryOutlined" :default PhotoLibraryOutlined]
            ["@material-ui/icons/PhotoLibraryRounded" :default PhotoLibraryRounded]
            ["@material-ui/icons/PhotoLibrarySharp" :default PhotoLibrarySharp]
            ["@material-ui/icons/PhotoLibraryTwoTone" :default PhotoLibraryTwoTone]
            ["@material-ui/icons/PhotoOutlined" :default PhotoOutlined]
            ["@material-ui/icons/PhotoRounded" :default PhotoRounded]
            ["@material-ui/icons/PhotoSharp" :default PhotoSharp]
            ["@material-ui/icons/PhotoSizeSelectActual" :default PhotoSizeSelectActual]
            ["@material-ui/icons/PhotoSizeSelectActualOutlined" :default PhotoSizeSelectActualOutlined]
            ["@material-ui/icons/PhotoSizeSelectActualRounded" :default PhotoSizeSelectActualRounded]
            ["@material-ui/icons/PhotoSizeSelectActualSharp" :default PhotoSizeSelectActualSharp]
            ["@material-ui/icons/PhotoSizeSelectActualTwoTone" :default PhotoSizeSelectActualTwoTone]
            ["@material-ui/icons/PhotoSizeSelectLarge" :default PhotoSizeSelectLarge]
            ["@material-ui/icons/PhotoSizeSelectLargeOutlined" :default PhotoSizeSelectLargeOutlined]
            ["@material-ui/icons/PhotoSizeSelectLargeRounded" :default PhotoSizeSelectLargeRounded]
            ["@material-ui/icons/PhotoSizeSelectLargeSharp" :default PhotoSizeSelectLargeSharp]
            ["@material-ui/icons/PhotoSizeSelectLargeTwoTone" :default PhotoSizeSelectLargeTwoTone]
            ["@material-ui/icons/PhotoSizeSelectSmall" :default PhotoSizeSelectSmall]
            ["@material-ui/icons/PhotoSizeSelectSmallOutlined" :default PhotoSizeSelectSmallOutlined]
            ["@material-ui/icons/PhotoSizeSelectSmallRounded" :default PhotoSizeSelectSmallRounded]
            ["@material-ui/icons/PhotoSizeSelectSmallSharp" :default PhotoSizeSelectSmallSharp]
            ["@material-ui/icons/PhotoSizeSelectSmallTwoTone" :default PhotoSizeSelectSmallTwoTone]
            ["@material-ui/icons/PhotoTwoTone" :default PhotoTwoTone]
            ["@material-ui/icons/PictureAsPdf" :default PictureAsPdf]
            ["@material-ui/icons/PictureAsPdfOutlined" :default PictureAsPdfOutlined]
            ["@material-ui/icons/PictureAsPdfRounded" :default PictureAsPdfRounded]
            ["@material-ui/icons/PictureAsPdfSharp" :default PictureAsPdfSharp]
            ["@material-ui/icons/PictureAsPdfTwoTone" :default PictureAsPdfTwoTone]
            ["@material-ui/icons/PictureInPicture" :default PictureInPicture]
            ["@material-ui/icons/PictureInPictureAlt" :default PictureInPictureAlt]
            ["@material-ui/icons/PictureInPictureAltOutlined" :default PictureInPictureAltOutlined]
            ["@material-ui/icons/PictureInPictureAltRounded" :default PictureInPictureAltRounded]
            ["@material-ui/icons/PictureInPictureAltSharp" :default PictureInPictureAltSharp]
            ["@material-ui/icons/PictureInPictureAltTwoTone" :default PictureInPictureAltTwoTone]
            ["@material-ui/icons/PictureInPictureOutlined" :default PictureInPictureOutlined]
            ["@material-ui/icons/PictureInPictureRounded" :default PictureInPictureRounded]
            ["@material-ui/icons/PictureInPictureSharp" :default PictureInPictureSharp]
            ["@material-ui/icons/PictureInPictureTwoTone" :default PictureInPictureTwoTone]
            ["@material-ui/icons/PieChart" :default PieChart]
            ["@material-ui/icons/PieChartOutlined" :default PieChartOutlined]
            ["@material-ui/icons/PieChartRounded" :default PieChartRounded]
            ["@material-ui/icons/PieChartSharp" :default PieChartSharp]
            ["@material-ui/icons/PieChartTwoTone" :default PieChartTwoTone]
            ["@material-ui/icons/PinDrop" :default PinDrop]
            ["@material-ui/icons/PinDropOutlined" :default PinDropOutlined]
            ["@material-ui/icons/PinDropRounded" :default PinDropRounded]
            ["@material-ui/icons/PinDropSharp" :default PinDropSharp]
            ["@material-ui/icons/PinDropTwoTone" :default PinDropTwoTone]
            ["@material-ui/icons/Pinterest" :default Pinterest]
            ["@material-ui/icons/Place" :default Place]
            ["@material-ui/icons/PlaceOutlined" :default PlaceOutlined]
            ["@material-ui/icons/PlaceRounded" :default PlaceRounded]
            ["@material-ui/icons/PlaceSharp" :default PlaceSharp]
            ["@material-ui/icons/PlaceTwoTone" :default PlaceTwoTone]
            ["@material-ui/icons/PlayArrow" :default PlayArrow]
            ["@material-ui/icons/PlayArrowOutlined" :default PlayArrowOutlined]
            ["@material-ui/icons/PlayArrowRounded" :default PlayArrowRounded]
            ["@material-ui/icons/PlayArrowSharp" :default PlayArrowSharp]
            ["@material-ui/icons/PlayArrowTwoTone" :default PlayArrowTwoTone]
            ["@material-ui/icons/PlayCircleFilled" :default PlayCircleFilled]
            ["@material-ui/icons/PlayCircleFilledOutlined" :default PlayCircleFilledOutlined]
            ["@material-ui/icons/PlayCircleFilledRounded" :default PlayCircleFilledRounded]
            ["@material-ui/icons/PlayCircleFilledSharp" :default PlayCircleFilledSharp]
            ["@material-ui/icons/PlayCircleFilledTwoTone" :default PlayCircleFilledTwoTone]
            ["@material-ui/icons/PlayCircleFilledWhite" :default PlayCircleFilledWhite]
            ["@material-ui/icons/PlayCircleFilledWhiteOutlined" :default PlayCircleFilledWhiteOutlined]
            ["@material-ui/icons/PlayCircleFilledWhiteRounded" :default PlayCircleFilledWhiteRounded]
            ["@material-ui/icons/PlayCircleFilledWhiteSharp" :default PlayCircleFilledWhiteSharp]
            ["@material-ui/icons/PlayCircleFilledWhiteTwoTone" :default PlayCircleFilledWhiteTwoTone]
            ["@material-ui/icons/PlayCircleOutline" :default PlayCircleOutline]
            ["@material-ui/icons/PlayCircleOutlineOutlined" :default PlayCircleOutlineOutlined]
            ["@material-ui/icons/PlayCircleOutlineRounded" :default PlayCircleOutlineRounded]
            ["@material-ui/icons/PlayCircleOutlineSharp" :default PlayCircleOutlineSharp]
            ["@material-ui/icons/PlayCircleOutlineTwoTone" :default PlayCircleOutlineTwoTone]
            ["@material-ui/icons/PlayForWork" :default PlayForWork]
            ["@material-ui/icons/PlayForWorkOutlined" :default PlayForWorkOutlined]
            ["@material-ui/icons/PlayForWorkRounded" :default PlayForWorkRounded]
            ["@material-ui/icons/PlayForWorkSharp" :default PlayForWorkSharp]
            ["@material-ui/icons/PlayForWorkTwoTone" :default PlayForWorkTwoTone]
            ["@material-ui/icons/PlaylistAdd" :default PlaylistAdd]
            ["@material-ui/icons/PlaylistAddCheck" :default PlaylistAddCheck]
            ["@material-ui/icons/PlaylistAddCheckOutlined" :default PlaylistAddCheckOutlined]
            ["@material-ui/icons/PlaylistAddCheckRounded" :default PlaylistAddCheckRounded]
            ["@material-ui/icons/PlaylistAddCheckSharp" :default PlaylistAddCheckSharp]
            ["@material-ui/icons/PlaylistAddCheckTwoTone" :default PlaylistAddCheckTwoTone]
            ["@material-ui/icons/PlaylistAddOutlined" :default PlaylistAddOutlined]
            ["@material-ui/icons/PlaylistAddRounded" :default PlaylistAddRounded]
            ["@material-ui/icons/PlaylistAddSharp" :default PlaylistAddSharp]
            ["@material-ui/icons/PlaylistAddTwoTone" :default PlaylistAddTwoTone]
            ["@material-ui/icons/PlaylistPlay" :default PlaylistPlay]
            ["@material-ui/icons/PlaylistPlayOutlined" :default PlaylistPlayOutlined]
            ["@material-ui/icons/PlaylistPlayRounded" :default PlaylistPlayRounded]
            ["@material-ui/icons/PlaylistPlaySharp" :default PlaylistPlaySharp]
            ["@material-ui/icons/PlaylistPlayTwoTone" :default PlaylistPlayTwoTone]
            ["@material-ui/icons/PlusOne" :default PlusOne]
            ["@material-ui/icons/PlusOneOutlined" :default PlusOneOutlined]
            ["@material-ui/icons/PlusOneRounded" :default PlusOneRounded]
            ["@material-ui/icons/PlusOneSharp" :default PlusOneSharp]
            ["@material-ui/icons/PlusOneTwoTone" :default PlusOneTwoTone]
            ["@material-ui/icons/Policy" :default Policy]
            ["@material-ui/icons/PolicyOutlined" :default PolicyOutlined]
            ["@material-ui/icons/PolicyRounded" :default PolicyRounded]
            ["@material-ui/icons/PolicySharp" :default PolicySharp]
            ["@material-ui/icons/PolicyTwoTone" :default PolicyTwoTone]
            ["@material-ui/icons/Poll" :default Poll]
            ["@material-ui/icons/PollOutlined" :default PollOutlined]
            ["@material-ui/icons/PollRounded" :default PollRounded]
            ["@material-ui/icons/PollSharp" :default PollSharp]
            ["@material-ui/icons/PollTwoTone" :default PollTwoTone]
            ["@material-ui/icons/Polymer" :default Polymer]
            ["@material-ui/icons/PolymerOutlined" :default PolymerOutlined]
            ["@material-ui/icons/PolymerRounded" :default PolymerRounded]
            ["@material-ui/icons/PolymerSharp" :default PolymerSharp]
            ["@material-ui/icons/PolymerTwoTone" :default PolymerTwoTone]
            ["@material-ui/icons/Pool" :default Pool]
            ["@material-ui/icons/PoolOutlined" :default PoolOutlined]
            ["@material-ui/icons/PoolRounded" :default PoolRounded]
            ["@material-ui/icons/PoolSharp" :default PoolSharp]
            ["@material-ui/icons/PoolTwoTone" :default PoolTwoTone]
            ["@material-ui/icons/PortableWifiOff" :default PortableWifiOff]
            ["@material-ui/icons/PortableWifiOffOutlined" :default PortableWifiOffOutlined]
            ["@material-ui/icons/PortableWifiOffRounded" :default PortableWifiOffRounded]
            ["@material-ui/icons/PortableWifiOffSharp" :default PortableWifiOffSharp]
            ["@material-ui/icons/PortableWifiOffTwoTone" :default PortableWifiOffTwoTone]
            ["@material-ui/icons/Portrait" :default Portrait]
            ["@material-ui/icons/PortraitOutlined" :default PortraitOutlined]
            ["@material-ui/icons/PortraitRounded" :default PortraitRounded]
            ["@material-ui/icons/PortraitSharp" :default PortraitSharp]
            ["@material-ui/icons/PortraitTwoTone" :default PortraitTwoTone]
            ["@material-ui/icons/PostAdd" :default PostAdd]
            ["@material-ui/icons/PostAddOutlined" :default PostAddOutlined]
            ["@material-ui/icons/PostAddRounded" :default PostAddRounded]
            ["@material-ui/icons/PostAddSharp" :default PostAddSharp]
            ["@material-ui/icons/PostAddTwoTone" :default PostAddTwoTone]
            ["@material-ui/icons/Power" :default Power]
            ["@material-ui/icons/PowerInput" :default PowerInput]
            ["@material-ui/icons/PowerInputOutlined" :default PowerInputOutlined]
            ["@material-ui/icons/PowerInputRounded" :default PowerInputRounded]
            ["@material-ui/icons/PowerInputSharp" :default PowerInputSharp]
            ["@material-ui/icons/PowerInputTwoTone" :default PowerInputTwoTone]
            ["@material-ui/icons/PowerOff" :default PowerOff]
            ["@material-ui/icons/PowerOffOutlined" :default PowerOffOutlined]
            ["@material-ui/icons/PowerOffRounded" :default PowerOffRounded]
            ["@material-ui/icons/PowerOffSharp" :default PowerOffSharp]
            ["@material-ui/icons/PowerOffTwoTone" :default PowerOffTwoTone]
            ["@material-ui/icons/PowerOutlined" :default PowerOutlined]
            ["@material-ui/icons/PowerRounded" :default PowerRounded]
            ["@material-ui/icons/PowerSettingsNew" :default PowerSettingsNew]
            ["@material-ui/icons/PowerSettingsNewOutlined" :default PowerSettingsNewOutlined]
            ["@material-ui/icons/PowerSettingsNewRounded" :default PowerSettingsNewRounded]
            ["@material-ui/icons/PowerSettingsNewSharp" :default PowerSettingsNewSharp]
            ["@material-ui/icons/PowerSettingsNewTwoTone" :default PowerSettingsNewTwoTone]
            ["@material-ui/icons/PowerSharp" :default PowerSharp]
            ["@material-ui/icons/PowerTwoTone" :default PowerTwoTone]
            ["@material-ui/icons/PregnantWoman" :default PregnantWoman]
            ["@material-ui/icons/PregnantWomanOutlined" :default PregnantWomanOutlined]
            ["@material-ui/icons/PregnantWomanRounded" :default PregnantWomanRounded]
            ["@material-ui/icons/PregnantWomanSharp" :default PregnantWomanSharp]
            ["@material-ui/icons/PregnantWomanTwoTone" :default PregnantWomanTwoTone]
            ["@material-ui/icons/PresentToAll" :default PresentToAll]
            ["@material-ui/icons/PresentToAllOutlined" :default PresentToAllOutlined]
            ["@material-ui/icons/PresentToAllRounded" :default PresentToAllRounded]
            ["@material-ui/icons/PresentToAllSharp" :default PresentToAllSharp]
            ["@material-ui/icons/PresentToAllTwoTone" :default PresentToAllTwoTone]
            ["@material-ui/icons/Print" :default Print]
            ["@material-ui/icons/PrintDisabled" :default PrintDisabled]
            ["@material-ui/icons/PrintDisabledOutlined" :default PrintDisabledOutlined]
            ["@material-ui/icons/PrintDisabledRounded" :default PrintDisabledRounded]
            ["@material-ui/icons/PrintDisabledSharp" :default PrintDisabledSharp]
            ["@material-ui/icons/PrintDisabledTwoTone" :default PrintDisabledTwoTone]
            ["@material-ui/icons/PrintOutlined" :default PrintOutlined]
            ["@material-ui/icons/PrintRounded" :default PrintRounded]
            ["@material-ui/icons/PrintSharp" :default PrintSharp]
            ["@material-ui/icons/PrintTwoTone" :default PrintTwoTone]
            ["@material-ui/icons/PriorityHigh" :default PriorityHigh]
            ["@material-ui/icons/PriorityHighOutlined" :default PriorityHighOutlined]
            ["@material-ui/icons/PriorityHighRounded" :default PriorityHighRounded]
            ["@material-ui/icons/PriorityHighSharp" :default PriorityHighSharp]
            ["@material-ui/icons/PriorityHighTwoTone" :default PriorityHighTwoTone]
            ["@material-ui/icons/Public" :default Public]
            ["@material-ui/icons/PublicOutlined" :default PublicOutlined]
            ["@material-ui/icons/PublicRounded" :default PublicRounded]
            ["@material-ui/icons/PublicSharp" :default PublicSharp]
            ["@material-ui/icons/PublicTwoTone" :default PublicTwoTone]
            ["@material-ui/icons/Publish" :default Publish]
            ["@material-ui/icons/PublishOutlined" :default PublishOutlined]
            ["@material-ui/icons/PublishRounded" :default PublishRounded]
            ["@material-ui/icons/PublishSharp" :default PublishSharp]
            ["@material-ui/icons/PublishTwoTone" :default PublishTwoTone]
            ["@material-ui/icons/QueryBuilder" :default QueryBuilder]
            ["@material-ui/icons/QueryBuilderOutlined" :default QueryBuilderOutlined]
            ["@material-ui/icons/QueryBuilderRounded" :default QueryBuilderRounded]
            ["@material-ui/icons/QueryBuilderSharp" :default QueryBuilderSharp]
            ["@material-ui/icons/QueryBuilderTwoTone" :default QueryBuilderTwoTone]
            ["@material-ui/icons/QuestionAnswer" :default QuestionAnswer]
            ["@material-ui/icons/QuestionAnswerOutlined" :default QuestionAnswerOutlined]
            ["@material-ui/icons/QuestionAnswerRounded" :default QuestionAnswerRounded]
            ["@material-ui/icons/QuestionAnswerSharp" :default QuestionAnswerSharp]
            ["@material-ui/icons/QuestionAnswerTwoTone" :default QuestionAnswerTwoTone]
            ["@material-ui/icons/Queue" :default Queue]
            ["@material-ui/icons/QueueMusic" :default QueueMusic]
            ["@material-ui/icons/QueueMusicOutlined" :default QueueMusicOutlined]
            ["@material-ui/icons/QueueMusicRounded" :default QueueMusicRounded]
            ["@material-ui/icons/QueueMusicSharp" :default QueueMusicSharp]
            ["@material-ui/icons/QueueMusicTwoTone" :default QueueMusicTwoTone]
            ["@material-ui/icons/QueueOutlined" :default QueueOutlined]
            ["@material-ui/icons/QueuePlayNext" :default QueuePlayNext]
            ["@material-ui/icons/QueuePlayNextOutlined" :default QueuePlayNextOutlined]
            ["@material-ui/icons/QueuePlayNextRounded" :default QueuePlayNextRounded]
            ["@material-ui/icons/QueuePlayNextSharp" :default QueuePlayNextSharp]
            ["@material-ui/icons/QueuePlayNextTwoTone" :default QueuePlayNextTwoTone]
            ["@material-ui/icons/QueueRounded" :default QueueRounded]
            ["@material-ui/icons/QueueSharp" :default QueueSharp]
            ["@material-ui/icons/QueueTwoTone" :default QueueTwoTone]
            ["@material-ui/icons/Radio" :default Radio]
            ["@material-ui/icons/RadioButtonChecked" :default RadioButtonChecked]
            ["@material-ui/icons/RadioButtonCheckedOutlined" :default RadioButtonCheckedOutlined]
            ["@material-ui/icons/RadioButtonCheckedRounded" :default RadioButtonCheckedRounded]
            ["@material-ui/icons/RadioButtonCheckedSharp" :default RadioButtonCheckedSharp]
            ["@material-ui/icons/RadioButtonCheckedTwoTone" :default RadioButtonCheckedTwoTone]
            ["@material-ui/icons/RadioButtonUnchecked" :default RadioButtonUnchecked]
            ["@material-ui/icons/RadioButtonUncheckedOutlined" :default RadioButtonUncheckedOutlined]
            ["@material-ui/icons/RadioButtonUncheckedRounded" :default RadioButtonUncheckedRounded]
            ["@material-ui/icons/RadioButtonUncheckedSharp" :default RadioButtonUncheckedSharp]
            ["@material-ui/icons/RadioButtonUncheckedTwoTone" :default RadioButtonUncheckedTwoTone]
            ["@material-ui/icons/RadioOutlined" :default RadioOutlined]
            ["@material-ui/icons/RadioRounded" :default RadioRounded]
            ["@material-ui/icons/RadioSharp" :default RadioSharp]
            ["@material-ui/icons/RadioTwoTone" :default RadioTwoTone]
            ["@material-ui/icons/RateReview" :default RateReview]
            ["@material-ui/icons/RateReviewOutlined" :default RateReviewOutlined]
            ["@material-ui/icons/RateReviewRounded" :default RateReviewRounded]
            ["@material-ui/icons/RateReviewSharp" :default RateReviewSharp]
            ["@material-ui/icons/RateReviewTwoTone" :default RateReviewTwoTone]
            ["@material-ui/icons/Receipt" :default Receipt]
            ["@material-ui/icons/ReceiptOutlined" :default ReceiptOutlined]
            ["@material-ui/icons/ReceiptRounded" :default ReceiptRounded]
            ["@material-ui/icons/ReceiptSharp" :default ReceiptSharp]
            ["@material-ui/icons/ReceiptTwoTone" :default ReceiptTwoTone]
            ["@material-ui/icons/RecentActors" :default RecentActors]
            ["@material-ui/icons/RecentActorsOutlined" :default RecentActorsOutlined]
            ["@material-ui/icons/RecentActorsRounded" :default RecentActorsRounded]
            ["@material-ui/icons/RecentActorsSharp" :default RecentActorsSharp]
            ["@material-ui/icons/RecentActorsTwoTone" :default RecentActorsTwoTone]
            ["@material-ui/icons/RecordVoiceOver" :default RecordVoiceOver]
            ["@material-ui/icons/RecordVoiceOverOutlined" :default RecordVoiceOverOutlined]
            ["@material-ui/icons/RecordVoiceOverRounded" :default RecordVoiceOverRounded]
            ["@material-ui/icons/RecordVoiceOverSharp" :default RecordVoiceOverSharp]
            ["@material-ui/icons/RecordVoiceOverTwoTone" :default RecordVoiceOverTwoTone]
            ["@material-ui/icons/Reddit" :default Reddit]
            ["@material-ui/icons/Redeem" :default Redeem]
            ["@material-ui/icons/RedeemOutlined" :default RedeemOutlined]
            ["@material-ui/icons/RedeemRounded" :default RedeemRounded]
            ["@material-ui/icons/RedeemSharp" :default RedeemSharp]
            ["@material-ui/icons/RedeemTwoTone" :default RedeemTwoTone]
            ["@material-ui/icons/Redo" :default Redo]
            ["@material-ui/icons/RedoOutlined" :default RedoOutlined]
            ["@material-ui/icons/RedoRounded" :default RedoRounded]
            ["@material-ui/icons/RedoSharp" :default RedoSharp]
            ["@material-ui/icons/RedoTwoTone" :default RedoTwoTone]
            ["@material-ui/icons/Refresh" :default Refresh]
            ["@material-ui/icons/RefreshOutlined" :default RefreshOutlined]
            ["@material-ui/icons/RefreshRounded" :default RefreshRounded]
            ["@material-ui/icons/RefreshSharp" :default RefreshSharp]
            ["@material-ui/icons/RefreshTwoTone" :default RefreshTwoTone]
            ["@material-ui/icons/Remove" :default Remove]
            ["@material-ui/icons/RemoveCircle" :default RemoveCircle]
            ["@material-ui/icons/RemoveCircleOutline" :default RemoveCircleOutline]
            ["@material-ui/icons/RemoveCircleOutlined" :default RemoveCircleOutlined]
            ["@material-ui/icons/RemoveCircleOutlineOutlined" :default RemoveCircleOutlineOutlined]
            ["@material-ui/icons/RemoveCircleOutlineRounded" :default RemoveCircleOutlineRounded]
            ["@material-ui/icons/RemoveCircleOutlineSharp" :default RemoveCircleOutlineSharp]
            ["@material-ui/icons/RemoveCircleOutlineTwoTone" :default RemoveCircleOutlineTwoTone]
            ["@material-ui/icons/RemoveCircleRounded" :default RemoveCircleRounded]
            ["@material-ui/icons/RemoveCircleSharp" :default RemoveCircleSharp]
            ["@material-ui/icons/RemoveCircleTwoTone" :default RemoveCircleTwoTone]
            ["@material-ui/icons/RemoveFromQueue" :default RemoveFromQueue]
            ["@material-ui/icons/RemoveFromQueueOutlined" :default RemoveFromQueueOutlined]
            ["@material-ui/icons/RemoveFromQueueRounded" :default RemoveFromQueueRounded]
            ["@material-ui/icons/RemoveFromQueueSharp" :default RemoveFromQueueSharp]
            ["@material-ui/icons/RemoveFromQueueTwoTone" :default RemoveFromQueueTwoTone]
            ["@material-ui/icons/RemoveOutlined" :default RemoveOutlined]
            ["@material-ui/icons/RemoveRedEye" :default RemoveRedEye]
            ["@material-ui/icons/RemoveRedEyeOutlined" :default RemoveRedEyeOutlined]
            ["@material-ui/icons/RemoveRedEyeRounded" :default RemoveRedEyeRounded]
            ["@material-ui/icons/RemoveRedEyeSharp" :default RemoveRedEyeSharp]
            ["@material-ui/icons/RemoveRedEyeTwoTone" :default RemoveRedEyeTwoTone]
            ["@material-ui/icons/RemoveRounded" :default RemoveRounded]
            ["@material-ui/icons/RemoveSharp" :default RemoveSharp]
            ["@material-ui/icons/RemoveShoppingCart" :default RemoveShoppingCart]
            ["@material-ui/icons/RemoveShoppingCartOutlined" :default RemoveShoppingCartOutlined]
            ["@material-ui/icons/RemoveShoppingCartRounded" :default RemoveShoppingCartRounded]
            ["@material-ui/icons/RemoveShoppingCartSharp" :default RemoveShoppingCartSharp]
            ["@material-ui/icons/RemoveShoppingCartTwoTone" :default RemoveShoppingCartTwoTone]
            ["@material-ui/icons/RemoveTwoTone" :default RemoveTwoTone]
            ["@material-ui/icons/Reorder" :default Reorder]
            ["@material-ui/icons/ReorderOutlined" :default ReorderOutlined]
            ["@material-ui/icons/ReorderRounded" :default ReorderRounded]
            ["@material-ui/icons/ReorderSharp" :default ReorderSharp]
            ["@material-ui/icons/ReorderTwoTone" :default ReorderTwoTone]
            ["@material-ui/icons/Repeat" :default Repeat]
            ["@material-ui/icons/RepeatOne" :default RepeatOne]
            ["@material-ui/icons/RepeatOneOutlined" :default RepeatOneOutlined]
            ["@material-ui/icons/RepeatOneRounded" :default RepeatOneRounded]
            ["@material-ui/icons/RepeatOneSharp" :default RepeatOneSharp]
            ["@material-ui/icons/RepeatOneTwoTone" :default RepeatOneTwoTone]
            ["@material-ui/icons/RepeatOutlined" :default RepeatOutlined]
            ["@material-ui/icons/RepeatRounded" :default RepeatRounded]
            ["@material-ui/icons/RepeatSharp" :default RepeatSharp]
            ["@material-ui/icons/RepeatTwoTone" :default RepeatTwoTone]
            ["@material-ui/icons/Replay" :default Replay]
            ["@material-ui/icons/Replay10" :default Replay10]
            ["@material-ui/icons/Replay10Outlined" :default Replay10Outlined]
            ["@material-ui/icons/Replay10Rounded" :default Replay10Rounded]
            ["@material-ui/icons/Replay10Sharp" :default Replay10Sharp]
            ["@material-ui/icons/Replay10TwoTone" :default Replay10TwoTone]
            ["@material-ui/icons/Replay30" :default Replay30]
            ["@material-ui/icons/Replay30Outlined" :default Replay30Outlined]
            ["@material-ui/icons/Replay30Rounded" :default Replay30Rounded]
            ["@material-ui/icons/Replay30Sharp" :default Replay30Sharp]
            ["@material-ui/icons/Replay30TwoTone" :default Replay30TwoTone]
            ["@material-ui/icons/Replay5" :default Replay5]
            ["@material-ui/icons/Replay5Outlined" :default Replay5Outlined]
            ["@material-ui/icons/Replay5Rounded" :default Replay5Rounded]
            ["@material-ui/icons/Replay5Sharp" :default Replay5Sharp]
            ["@material-ui/icons/Replay5TwoTone" :default Replay5TwoTone]
            ["@material-ui/icons/ReplayOutlined" :default ReplayOutlined]
            ["@material-ui/icons/ReplayRounded" :default ReplayRounded]
            ["@material-ui/icons/ReplaySharp" :default ReplaySharp]
            ["@material-ui/icons/ReplayTwoTone" :default ReplayTwoTone]
            ["@material-ui/icons/Reply" :default Reply]
            ["@material-ui/icons/ReplyAll" :default ReplyAll]
            ["@material-ui/icons/ReplyAllOutlined" :default ReplyAllOutlined]
            ["@material-ui/icons/ReplyAllRounded" :default ReplyAllRounded]
            ["@material-ui/icons/ReplyAllSharp" :default ReplyAllSharp]
            ["@material-ui/icons/ReplyAllTwoTone" :default ReplyAllTwoTone]
            ["@material-ui/icons/ReplyOutlined" :default ReplyOutlined]
            ["@material-ui/icons/ReplyRounded" :default ReplyRounded]
            ["@material-ui/icons/ReplySharp" :default ReplySharp]
            ["@material-ui/icons/ReplyTwoTone" :default ReplyTwoTone]
            ["@material-ui/icons/Report" :default Report]
            ["@material-ui/icons/ReportOff" :default ReportOff]
            ["@material-ui/icons/ReportOffOutlined" :default ReportOffOutlined]
            ["@material-ui/icons/ReportOffRounded" :default ReportOffRounded]
            ["@material-ui/icons/ReportOffSharp" :default ReportOffSharp]
            ["@material-ui/icons/ReportOffTwoTone" :default ReportOffTwoTone]
            ["@material-ui/icons/ReportOutlined" :default ReportOutlined]
            ["@material-ui/icons/ReportProblem" :default ReportProblem]
            ["@material-ui/icons/ReportProblemOutlined" :default ReportProblemOutlined]
            ["@material-ui/icons/ReportProblemRounded" :default ReportProblemRounded]
            ["@material-ui/icons/ReportProblemSharp" :default ReportProblemSharp]
            ["@material-ui/icons/ReportProblemTwoTone" :default ReportProblemTwoTone]
            ["@material-ui/icons/ReportRounded" :default ReportRounded]
            ["@material-ui/icons/ReportSharp" :default ReportSharp]
            ["@material-ui/icons/ReportTwoTone" :default ReportTwoTone]
            ["@material-ui/icons/Restaurant" :default Restaurant]
            ["@material-ui/icons/RestaurantMenu" :default RestaurantMenu]
            ["@material-ui/icons/RestaurantMenuOutlined" :default RestaurantMenuOutlined]
            ["@material-ui/icons/RestaurantMenuRounded" :default RestaurantMenuRounded]
            ["@material-ui/icons/RestaurantMenuSharp" :default RestaurantMenuSharp]
            ["@material-ui/icons/RestaurantMenuTwoTone" :default RestaurantMenuTwoTone]
            ["@material-ui/icons/RestaurantOutlined" :default RestaurantOutlined]
            ["@material-ui/icons/RestaurantRounded" :default RestaurantRounded]
            ["@material-ui/icons/RestaurantSharp" :default RestaurantSharp]
            ["@material-ui/icons/RestaurantTwoTone" :default RestaurantTwoTone]
            ["@material-ui/icons/Restore" :default Restore]
            ["@material-ui/icons/RestoreFromTrash" :default RestoreFromTrash]
            ["@material-ui/icons/RestoreFromTrashOutlined" :default RestoreFromTrashOutlined]
            ["@material-ui/icons/RestoreFromTrashRounded" :default RestoreFromTrashRounded]
            ["@material-ui/icons/RestoreFromTrashSharp" :default RestoreFromTrashSharp]
            ["@material-ui/icons/RestoreFromTrashTwoTone" :default RestoreFromTrashTwoTone]
            ["@material-ui/icons/RestoreOutlined" :default RestoreOutlined]
            ["@material-ui/icons/RestorePage" :default RestorePage]
            ["@material-ui/icons/RestorePageOutlined" :default RestorePageOutlined]
            ["@material-ui/icons/RestorePageRounded" :default RestorePageRounded]
            ["@material-ui/icons/RestorePageSharp" :default RestorePageSharp]
            ["@material-ui/icons/RestorePageTwoTone" :default RestorePageTwoTone]
            ["@material-ui/icons/RestoreRounded" :default RestoreRounded]
            ["@material-ui/icons/RestoreSharp" :default RestoreSharp]
            ["@material-ui/icons/RestoreTwoTone" :default RestoreTwoTone]
            ["@material-ui/icons/RingVolume" :default RingVolume]
            ["@material-ui/icons/RingVolumeOutlined" :default RingVolumeOutlined]
            ["@material-ui/icons/RingVolumeRounded" :default RingVolumeRounded]
            ["@material-ui/icons/RingVolumeSharp" :default RingVolumeSharp]
            ["@material-ui/icons/RingVolumeTwoTone" :default RingVolumeTwoTone]
            ["@material-ui/icons/Room" :default Room]
            ["@material-ui/icons/RoomOutlined" :default RoomOutlined]
            ["@material-ui/icons/RoomRounded" :default RoomRounded]
            ["@material-ui/icons/RoomService" :default RoomService]
            ["@material-ui/icons/RoomServiceOutlined" :default RoomServiceOutlined]
            ["@material-ui/icons/RoomServiceRounded" :default RoomServiceRounded]
            ["@material-ui/icons/RoomServiceSharp" :default RoomServiceSharp]
            ["@material-ui/icons/RoomServiceTwoTone" :default RoomServiceTwoTone]
            ["@material-ui/icons/RoomSharp" :default RoomSharp]
            ["@material-ui/icons/RoomTwoTone" :default RoomTwoTone]
            ["@material-ui/icons/Rotate90DegreesCcw" :default Rotate90DegreesCcw]
            ["@material-ui/icons/Rotate90DegreesCcwOutlined" :default Rotate90DegreesCcwOutlined]
            ["@material-ui/icons/Rotate90DegreesCcwRounded" :default Rotate90DegreesCcwRounded]
            ["@material-ui/icons/Rotate90DegreesCcwSharp" :default Rotate90DegreesCcwSharp]
            ["@material-ui/icons/Rotate90DegreesCcwTwoTone" :default Rotate90DegreesCcwTwoTone]
            ["@material-ui/icons/RotateLeft" :default RotateLeft]
            ["@material-ui/icons/RotateLeftOutlined" :default RotateLeftOutlined]
            ["@material-ui/icons/RotateLeftRounded" :default RotateLeftRounded]
            ["@material-ui/icons/RotateLeftSharp" :default RotateLeftSharp]
            ["@material-ui/icons/RotateLeftTwoTone" :default RotateLeftTwoTone]
            ["@material-ui/icons/RotateRight" :default RotateRight]
            ["@material-ui/icons/RotateRightOutlined" :default RotateRightOutlined]
            ["@material-ui/icons/RotateRightRounded" :default RotateRightRounded]
            ["@material-ui/icons/RotateRightSharp" :default RotateRightSharp]
            ["@material-ui/icons/RotateRightTwoTone" :default RotateRightTwoTone]
            ["@material-ui/icons/RoundedCorner" :default RoundedCorner]
            ["@material-ui/icons/RoundedCornerOutlined" :default RoundedCornerOutlined]
            ["@material-ui/icons/RoundedCornerRounded" :default RoundedCornerRounded]
            ["@material-ui/icons/RoundedCornerSharp" :default RoundedCornerSharp]
            ["@material-ui/icons/RoundedCornerTwoTone" :default RoundedCornerTwoTone]
            ["@material-ui/icons/Router" :default Router]
            ["@material-ui/icons/RouterOutlined" :default RouterOutlined]
            ["@material-ui/icons/RouterRounded" :default RouterRounded]
            ["@material-ui/icons/RouterSharp" :default RouterSharp]
            ["@material-ui/icons/RouterTwoTone" :default RouterTwoTone]
            ["@material-ui/icons/Rowing" :default Rowing]
            ["@material-ui/icons/RowingOutlined" :default RowingOutlined]
            ["@material-ui/icons/RowingRounded" :default RowingRounded]
            ["@material-ui/icons/RowingSharp" :default RowingSharp]
            ["@material-ui/icons/RowingTwoTone" :default RowingTwoTone]
            ["@material-ui/icons/RssFeed" :default RssFeed]
            ["@material-ui/icons/RssFeedOutlined" :default RssFeedOutlined]
            ["@material-ui/icons/RssFeedRounded" :default RssFeedRounded]
            ["@material-ui/icons/RssFeedSharp" :default RssFeedSharp]
            ["@material-ui/icons/RssFeedTwoTone" :default RssFeedTwoTone]
            ["@material-ui/icons/RvHookup" :default RvHookup]
            ["@material-ui/icons/RvHookupOutlined" :default RvHookupOutlined]
            ["@material-ui/icons/RvHookupRounded" :default RvHookupRounded]
            ["@material-ui/icons/RvHookupSharp" :default RvHookupSharp]
            ["@material-ui/icons/RvHookupTwoTone" :default RvHookupTwoTone]
            ["@material-ui/icons/Satellite" :default Satellite]
            ["@material-ui/icons/SatelliteOutlined" :default SatelliteOutlined]
            ["@material-ui/icons/SatelliteRounded" :default SatelliteRounded]
            ["@material-ui/icons/SatelliteSharp" :default SatelliteSharp]
            ["@material-ui/icons/SatelliteTwoTone" :default SatelliteTwoTone]
            ["@material-ui/icons/Save" :default Save]
            ["@material-ui/icons/SaveAlt" :default SaveAlt]
            ["@material-ui/icons/SaveAltOutlined" :default SaveAltOutlined]
            ["@material-ui/icons/SaveAltRounded" :default SaveAltRounded]
            ["@material-ui/icons/SaveAltSharp" :default SaveAltSharp]
            ["@material-ui/icons/SaveAltTwoTone" :default SaveAltTwoTone]
            ["@material-ui/icons/SaveOutlined" :default SaveOutlined]
            ["@material-ui/icons/SaveRounded" :default SaveRounded]
            ["@material-ui/icons/SaveSharp" :default SaveSharp]
            ["@material-ui/icons/SaveTwoTone" :default SaveTwoTone]
            ["@material-ui/icons/Scanner" :default Scanner]
            ["@material-ui/icons/ScannerOutlined" :default ScannerOutlined]
            ["@material-ui/icons/ScannerRounded" :default ScannerRounded]
            ["@material-ui/icons/ScannerSharp" :default ScannerSharp]
            ["@material-ui/icons/ScannerTwoTone" :default ScannerTwoTone]
            ["@material-ui/icons/ScatterPlot" :default ScatterPlot]
            ["@material-ui/icons/ScatterPlotOutlined" :default ScatterPlotOutlined]
            ["@material-ui/icons/ScatterPlotRounded" :default ScatterPlotRounded]
            ["@material-ui/icons/ScatterPlotSharp" :default ScatterPlotSharp]
            ["@material-ui/icons/ScatterPlotTwoTone" :default ScatterPlotTwoTone]
            ["@material-ui/icons/Schedule" :default Schedule]
            ["@material-ui/icons/ScheduleOutlined" :default ScheduleOutlined]
            ["@material-ui/icons/ScheduleRounded" :default ScheduleRounded]
            ["@material-ui/icons/ScheduleSharp" :default ScheduleSharp]
            ["@material-ui/icons/ScheduleTwoTone" :default ScheduleTwoTone]
            ["@material-ui/icons/School" :default School]
            ["@material-ui/icons/SchoolOutlined" :default SchoolOutlined]
            ["@material-ui/icons/SchoolRounded" :default SchoolRounded]
            ["@material-ui/icons/SchoolSharp" :default SchoolSharp]
            ["@material-ui/icons/SchoolTwoTone" :default SchoolTwoTone]
            ["@material-ui/icons/Score" :default Score]
            ["@material-ui/icons/ScoreOutlined" :default ScoreOutlined]
            ["@material-ui/icons/ScoreRounded" :default ScoreRounded]
            ["@material-ui/icons/ScoreSharp" :default ScoreSharp]
            ["@material-ui/icons/ScoreTwoTone" :default ScoreTwoTone]
            ["@material-ui/icons/ScreenLockLandscape" :default ScreenLockLandscape]
            ["@material-ui/icons/ScreenLockLandscapeOutlined" :default ScreenLockLandscapeOutlined]
            ["@material-ui/icons/ScreenLockLandscapeRounded" :default ScreenLockLandscapeRounded]
            ["@material-ui/icons/ScreenLockLandscapeSharp" :default ScreenLockLandscapeSharp]
            ["@material-ui/icons/ScreenLockLandscapeTwoTone" :default ScreenLockLandscapeTwoTone]
            ["@material-ui/icons/ScreenLockPortrait" :default ScreenLockPortrait]
            ["@material-ui/icons/ScreenLockPortraitOutlined" :default ScreenLockPortraitOutlined]
            ["@material-ui/icons/ScreenLockPortraitRounded" :default ScreenLockPortraitRounded]
            ["@material-ui/icons/ScreenLockPortraitSharp" :default ScreenLockPortraitSharp]
            ["@material-ui/icons/ScreenLockPortraitTwoTone" :default ScreenLockPortraitTwoTone]
            ["@material-ui/icons/ScreenLockRotation" :default ScreenLockRotation]
            ["@material-ui/icons/ScreenLockRotationOutlined" :default ScreenLockRotationOutlined]
            ["@material-ui/icons/ScreenLockRotationRounded" :default ScreenLockRotationRounded]
            ["@material-ui/icons/ScreenLockRotationSharp" :default ScreenLockRotationSharp]
            ["@material-ui/icons/ScreenLockRotationTwoTone" :default ScreenLockRotationTwoTone]
            ["@material-ui/icons/ScreenRotation" :default ScreenRotation]
            ["@material-ui/icons/ScreenRotationOutlined" :default ScreenRotationOutlined]
            ["@material-ui/icons/ScreenRotationRounded" :default ScreenRotationRounded]
            ["@material-ui/icons/ScreenRotationSharp" :default ScreenRotationSharp]
            ["@material-ui/icons/ScreenRotationTwoTone" :default ScreenRotationTwoTone]
            ["@material-ui/icons/ScreenShare" :default ScreenShare]
            ["@material-ui/icons/ScreenShareOutlined" :default ScreenShareOutlined]
            ["@material-ui/icons/ScreenShareRounded" :default ScreenShareRounded]
            ["@material-ui/icons/ScreenShareSharp" :default ScreenShareSharp]
            ["@material-ui/icons/ScreenShareTwoTone" :default ScreenShareTwoTone]
            ["@material-ui/icons/SdCard" :default SdCard]
            ["@material-ui/icons/SdCardOutlined" :default SdCardOutlined]
            ["@material-ui/icons/SdCardRounded" :default SdCardRounded]
            ["@material-ui/icons/SdCardSharp" :default SdCardSharp]
            ["@material-ui/icons/SdCardTwoTone" :default SdCardTwoTone]
            ["@material-ui/icons/SdStorage" :default SdStorage]
            ["@material-ui/icons/SdStorageOutlined" :default SdStorageOutlined]
            ["@material-ui/icons/SdStorageRounded" :default SdStorageRounded]
            ["@material-ui/icons/SdStorageSharp" :default SdStorageSharp]
            ["@material-ui/icons/SdStorageTwoTone" :default SdStorageTwoTone]
            ["@material-ui/icons/Search" :default Search]
            ["@material-ui/icons/SearchOutlined" :default SearchOutlined]
            ["@material-ui/icons/SearchRounded" :default SearchRounded]
            ["@material-ui/icons/SearchSharp" :default SearchSharp]
            ["@material-ui/icons/SearchTwoTone" :default SearchTwoTone]
            ["@material-ui/icons/Security" :default Security]
            ["@material-ui/icons/SecurityOutlined" :default SecurityOutlined]
            ["@material-ui/icons/SecurityRounded" :default SecurityRounded]
            ["@material-ui/icons/SecuritySharp" :default SecuritySharp]
            ["@material-ui/icons/SecurityTwoTone" :default SecurityTwoTone]
            ["@material-ui/icons/SelectAll" :default SelectAll]
            ["@material-ui/icons/SelectAllOutlined" :default SelectAllOutlined]
            ["@material-ui/icons/SelectAllRounded" :default SelectAllRounded]
            ["@material-ui/icons/SelectAllSharp" :default SelectAllSharp]
            ["@material-ui/icons/SelectAllTwoTone" :default SelectAllTwoTone]
            ["@material-ui/icons/Send" :default Send]
            ["@material-ui/icons/SendOutlined" :default SendOutlined]
            ["@material-ui/icons/SendRounded" :default SendRounded]
            ["@material-ui/icons/SendSharp" :default SendSharp]
            ["@material-ui/icons/SendTwoTone" :default SendTwoTone]
            ["@material-ui/icons/SentimentDissatisfied" :default SentimentDissatisfied]
            ["@material-ui/icons/SentimentDissatisfiedOutlined" :default SentimentDissatisfiedOutlined]
            ["@material-ui/icons/SentimentDissatisfiedRounded" :default SentimentDissatisfiedRounded]
            ["@material-ui/icons/SentimentDissatisfiedSharp" :default SentimentDissatisfiedSharp]
            ["@material-ui/icons/SentimentDissatisfiedTwoTone" :default SentimentDissatisfiedTwoTone]
            ["@material-ui/icons/SentimentSatisfied" :default SentimentSatisfied]
            ["@material-ui/icons/SentimentSatisfiedAlt" :default SentimentSatisfiedAlt]
            ["@material-ui/icons/SentimentSatisfiedAltOutlined" :default SentimentSatisfiedAltOutlined]
            ["@material-ui/icons/SentimentSatisfiedAltRounded" :default SentimentSatisfiedAltRounded]
            ["@material-ui/icons/SentimentSatisfiedAltSharp" :default SentimentSatisfiedAltSharp]
            ["@material-ui/icons/SentimentSatisfiedAltTwoTone" :default SentimentSatisfiedAltTwoTone]
            ["@material-ui/icons/SentimentSatisfiedOutlined" :default SentimentSatisfiedOutlined]
            ["@material-ui/icons/SentimentSatisfiedRounded" :default SentimentSatisfiedRounded]
            ["@material-ui/icons/SentimentSatisfiedSharp" :default SentimentSatisfiedSharp]
            ["@material-ui/icons/SentimentSatisfiedTwoTone" :default SentimentSatisfiedTwoTone]
            ["@material-ui/icons/SentimentVeryDissatisfied" :default SentimentVeryDissatisfied]
            ["@material-ui/icons/SentimentVeryDissatisfiedOutlined" :default SentimentVeryDissatisfiedOutlined]
            ["@material-ui/icons/SentimentVeryDissatisfiedRounded" :default SentimentVeryDissatisfiedRounded]
            ["@material-ui/icons/SentimentVeryDissatisfiedSharp" :default SentimentVeryDissatisfiedSharp]
            ["@material-ui/icons/SentimentVeryDissatisfiedTwoTone" :default SentimentVeryDissatisfiedTwoTone]
            ["@material-ui/icons/SentimentVerySatisfied" :default SentimentVerySatisfied]
            ["@material-ui/icons/SentimentVerySatisfiedOutlined" :default SentimentVerySatisfiedOutlined]
            ["@material-ui/icons/SentimentVerySatisfiedRounded" :default SentimentVerySatisfiedRounded]
            ["@material-ui/icons/SentimentVerySatisfiedSharp" :default SentimentVerySatisfiedSharp]
            ["@material-ui/icons/SentimentVerySatisfiedTwoTone" :default SentimentVerySatisfiedTwoTone]
            ["@material-ui/icons/Settings" :default Settings]
            ["@material-ui/icons/SettingsApplications" :default SettingsApplications]
            ["@material-ui/icons/SettingsApplicationsOutlined" :default SettingsApplicationsOutlined]
            ["@material-ui/icons/SettingsApplicationsRounded" :default SettingsApplicationsRounded]
            ["@material-ui/icons/SettingsApplicationsSharp" :default SettingsApplicationsSharp]
            ["@material-ui/icons/SettingsApplicationsTwoTone" :default SettingsApplicationsTwoTone]
            ["@material-ui/icons/SettingsBackupRestore" :default SettingsBackupRestore]
            ["@material-ui/icons/SettingsBackupRestoreOutlined" :default SettingsBackupRestoreOutlined]
            ["@material-ui/icons/SettingsBackupRestoreRounded" :default SettingsBackupRestoreRounded]
            ["@material-ui/icons/SettingsBackupRestoreSharp" :default SettingsBackupRestoreSharp]
            ["@material-ui/icons/SettingsBackupRestoreTwoTone" :default SettingsBackupRestoreTwoTone]
            ["@material-ui/icons/SettingsBluetooth" :default SettingsBluetooth]
            ["@material-ui/icons/SettingsBluetoothOutlined" :default SettingsBluetoothOutlined]
            ["@material-ui/icons/SettingsBluetoothRounded" :default SettingsBluetoothRounded]
            ["@material-ui/icons/SettingsBluetoothSharp" :default SettingsBluetoothSharp]
            ["@material-ui/icons/SettingsBluetoothTwoTone" :default SettingsBluetoothTwoTone]
            ["@material-ui/icons/SettingsBrightness" :default SettingsBrightness]
            ["@material-ui/icons/SettingsBrightnessOutlined" :default SettingsBrightnessOutlined]
            ["@material-ui/icons/SettingsBrightnessRounded" :default SettingsBrightnessRounded]
            ["@material-ui/icons/SettingsBrightnessSharp" :default SettingsBrightnessSharp]
            ["@material-ui/icons/SettingsBrightnessTwoTone" :default SettingsBrightnessTwoTone]
            ["@material-ui/icons/SettingsCell" :default SettingsCell]
            ["@material-ui/icons/SettingsCellOutlined" :default SettingsCellOutlined]
            ["@material-ui/icons/SettingsCellRounded" :default SettingsCellRounded]
            ["@material-ui/icons/SettingsCellSharp" :default SettingsCellSharp]
            ["@material-ui/icons/SettingsCellTwoTone" :default SettingsCellTwoTone]
            ["@material-ui/icons/SettingsEthernet" :default SettingsEthernet]
            ["@material-ui/icons/SettingsEthernetOutlined" :default SettingsEthernetOutlined]
            ["@material-ui/icons/SettingsEthernetRounded" :default SettingsEthernetRounded]
            ["@material-ui/icons/SettingsEthernetSharp" :default SettingsEthernetSharp]
            ["@material-ui/icons/SettingsEthernetTwoTone" :default SettingsEthernetTwoTone]
            ["@material-ui/icons/SettingsInputAntenna" :default SettingsInputAntenna]
            ["@material-ui/icons/SettingsInputAntennaOutlined" :default SettingsInputAntennaOutlined]
            ["@material-ui/icons/SettingsInputAntennaRounded" :default SettingsInputAntennaRounded]
            ["@material-ui/icons/SettingsInputAntennaSharp" :default SettingsInputAntennaSharp]
            ["@material-ui/icons/SettingsInputAntennaTwoTone" :default SettingsInputAntennaTwoTone]
            ["@material-ui/icons/SettingsInputComponent" :default SettingsInputComponent]
            ["@material-ui/icons/SettingsInputComponentOutlined" :default SettingsInputComponentOutlined]
            ["@material-ui/icons/SettingsInputComponentRounded" :default SettingsInputComponentRounded]
            ["@material-ui/icons/SettingsInputComponentSharp" :default SettingsInputComponentSharp]
            ["@material-ui/icons/SettingsInputComponentTwoTone" :default SettingsInputComponentTwoTone]
            ["@material-ui/icons/SettingsInputComposite" :default SettingsInputComposite]
            ["@material-ui/icons/SettingsInputCompositeOutlined" :default SettingsInputCompositeOutlined]
            ["@material-ui/icons/SettingsInputCompositeRounded" :default SettingsInputCompositeRounded]
            ["@material-ui/icons/SettingsInputCompositeSharp" :default SettingsInputCompositeSharp]
            ["@material-ui/icons/SettingsInputCompositeTwoTone" :default SettingsInputCompositeTwoTone]
            ["@material-ui/icons/SettingsInputHdmi" :default SettingsInputHdmi]
            ["@material-ui/icons/SettingsInputHdmiOutlined" :default SettingsInputHdmiOutlined]
            ["@material-ui/icons/SettingsInputHdmiRounded" :default SettingsInputHdmiRounded]
            ["@material-ui/icons/SettingsInputHdmiSharp" :default SettingsInputHdmiSharp]
            ["@material-ui/icons/SettingsInputHdmiTwoTone" :default SettingsInputHdmiTwoTone]
            ["@material-ui/icons/SettingsInputSvideo" :default SettingsInputSvideo]
            ["@material-ui/icons/SettingsInputSvideoOutlined" :default SettingsInputSvideoOutlined]
            ["@material-ui/icons/SettingsInputSvideoRounded" :default SettingsInputSvideoRounded]
            ["@material-ui/icons/SettingsInputSvideoSharp" :default SettingsInputSvideoSharp]
            ["@material-ui/icons/SettingsInputSvideoTwoTone" :default SettingsInputSvideoTwoTone]
            ["@material-ui/icons/SettingsOutlined" :default SettingsOutlined]
            ["@material-ui/icons/SettingsOverscan" :default SettingsOverscan]
            ["@material-ui/icons/SettingsOverscanOutlined" :default SettingsOverscanOutlined]
            ["@material-ui/icons/SettingsOverscanRounded" :default SettingsOverscanRounded]
            ["@material-ui/icons/SettingsOverscanSharp" :default SettingsOverscanSharp]
            ["@material-ui/icons/SettingsOverscanTwoTone" :default SettingsOverscanTwoTone]
            ["@material-ui/icons/SettingsPhone" :default SettingsPhone]
            ["@material-ui/icons/SettingsPhoneOutlined" :default SettingsPhoneOutlined]
            ["@material-ui/icons/SettingsPhoneRounded" :default SettingsPhoneRounded]
            ["@material-ui/icons/SettingsPhoneSharp" :default SettingsPhoneSharp]
            ["@material-ui/icons/SettingsPhoneTwoTone" :default SettingsPhoneTwoTone]
            ["@material-ui/icons/SettingsPower" :default SettingsPower]
            ["@material-ui/icons/SettingsPowerOutlined" :default SettingsPowerOutlined]
            ["@material-ui/icons/SettingsPowerRounded" :default SettingsPowerRounded]
            ["@material-ui/icons/SettingsPowerSharp" :default SettingsPowerSharp]
            ["@material-ui/icons/SettingsPowerTwoTone" :default SettingsPowerTwoTone]
            ["@material-ui/icons/SettingsRemote" :default SettingsRemote]
            ["@material-ui/icons/SettingsRemoteOutlined" :default SettingsRemoteOutlined]
            ["@material-ui/icons/SettingsRemoteRounded" :default SettingsRemoteRounded]
            ["@material-ui/icons/SettingsRemoteSharp" :default SettingsRemoteSharp]
            ["@material-ui/icons/SettingsRemoteTwoTone" :default SettingsRemoteTwoTone]
            ["@material-ui/icons/SettingsRounded" :default SettingsRounded]
            ["@material-ui/icons/SettingsSharp" :default SettingsSharp]
            ["@material-ui/icons/SettingsSystemDaydream" :default SettingsSystemDaydream]
            ["@material-ui/icons/SettingsSystemDaydreamOutlined" :default SettingsSystemDaydreamOutlined]
            ["@material-ui/icons/SettingsSystemDaydreamRounded" :default SettingsSystemDaydreamRounded]
            ["@material-ui/icons/SettingsSystemDaydreamSharp" :default SettingsSystemDaydreamSharp]
            ["@material-ui/icons/SettingsSystemDaydreamTwoTone" :default SettingsSystemDaydreamTwoTone]
            ["@material-ui/icons/SettingsTwoTone" :default SettingsTwoTone]
            ["@material-ui/icons/SettingsVoice" :default SettingsVoice]
            ["@material-ui/icons/SettingsVoiceOutlined" :default SettingsVoiceOutlined]
            ["@material-ui/icons/SettingsVoiceRounded" :default SettingsVoiceRounded]
            ["@material-ui/icons/SettingsVoiceSharp" :default SettingsVoiceSharp]
            ["@material-ui/icons/SettingsVoiceTwoTone" :default SettingsVoiceTwoTone]
            ["@material-ui/icons/Share" :default Share]
            ["@material-ui/icons/ShareOutlined" :default ShareOutlined]
            ["@material-ui/icons/ShareRounded" :default ShareRounded]
            ["@material-ui/icons/ShareSharp" :default ShareSharp]
            ["@material-ui/icons/ShareTwoTone" :default ShareTwoTone]
            ["@material-ui/icons/Shop" :default Shop]
            ["@material-ui/icons/ShopOutlined" :default ShopOutlined]
            ["@material-ui/icons/ShoppingBasket" :default ShoppingBasket]
            ["@material-ui/icons/ShoppingBasketOutlined" :default ShoppingBasketOutlined]
            ["@material-ui/icons/ShoppingBasketRounded" :default ShoppingBasketRounded]
            ["@material-ui/icons/ShoppingBasketSharp" :default ShoppingBasketSharp]
            ["@material-ui/icons/ShoppingBasketTwoTone" :default ShoppingBasketTwoTone]
            ["@material-ui/icons/ShoppingCart" :default ShoppingCart]
            ["@material-ui/icons/ShoppingCartOutlined" :default ShoppingCartOutlined]
            ["@material-ui/icons/ShoppingCartRounded" :default ShoppingCartRounded]
            ["@material-ui/icons/ShoppingCartSharp" :default ShoppingCartSharp]
            ["@material-ui/icons/ShoppingCartTwoTone" :default ShoppingCartTwoTone]
            ["@material-ui/icons/ShopRounded" :default ShopRounded]
            ["@material-ui/icons/ShopSharp" :default ShopSharp]
            ["@material-ui/icons/ShopTwo" :default ShopTwo]
            ["@material-ui/icons/ShopTwoOutlined" :default ShopTwoOutlined]
            ["@material-ui/icons/ShopTwoRounded" :default ShopTwoRounded]
            ["@material-ui/icons/ShopTwoSharp" :default ShopTwoSharp]
            ["@material-ui/icons/ShopTwoTone" :default ShopTwoTone]
            ["@material-ui/icons/ShopTwoTwoTone" :default ShopTwoTwoTone]
            ["@material-ui/icons/ShortText" :default ShortText]
            ["@material-ui/icons/ShortTextOutlined" :default ShortTextOutlined]
            ["@material-ui/icons/ShortTextRounded" :default ShortTextRounded]
            ["@material-ui/icons/ShortTextSharp" :default ShortTextSharp]
            ["@material-ui/icons/ShortTextTwoTone" :default ShortTextTwoTone]
            ["@material-ui/icons/ShowChart" :default ShowChart]
            ["@material-ui/icons/ShowChartOutlined" :default ShowChartOutlined]
            ["@material-ui/icons/ShowChartRounded" :default ShowChartRounded]
            ["@material-ui/icons/ShowChartSharp" :default ShowChartSharp]
            ["@material-ui/icons/ShowChartTwoTone" :default ShowChartTwoTone]
            ["@material-ui/icons/Shuffle" :default Shuffle]
            ["@material-ui/icons/ShuffleOutlined" :default ShuffleOutlined]
            ["@material-ui/icons/ShuffleRounded" :default ShuffleRounded]
            ["@material-ui/icons/ShuffleSharp" :default ShuffleSharp]
            ["@material-ui/icons/ShuffleTwoTone" :default ShuffleTwoTone]
            ["@material-ui/icons/ShutterSpeed" :default ShutterSpeed]
            ["@material-ui/icons/ShutterSpeedOutlined" :default ShutterSpeedOutlined]
            ["@material-ui/icons/ShutterSpeedRounded" :default ShutterSpeedRounded]
            ["@material-ui/icons/ShutterSpeedSharp" :default ShutterSpeedSharp]
            ["@material-ui/icons/ShutterSpeedTwoTone" :default ShutterSpeedTwoTone]
            ["@material-ui/icons/SignalCellular0Bar" :default SignalCellular0Bar]
            ["@material-ui/icons/SignalCellular0BarOutlined" :default SignalCellular0BarOutlined]
            ["@material-ui/icons/SignalCellular0BarRounded" :default SignalCellular0BarRounded]
            ["@material-ui/icons/SignalCellular0BarSharp" :default SignalCellular0BarSharp]
            ["@material-ui/icons/SignalCellular0BarTwoTone" :default SignalCellular0BarTwoTone]
            ["@material-ui/icons/SignalCellular1Bar" :default SignalCellular1Bar]
            ["@material-ui/icons/SignalCellular1BarOutlined" :default SignalCellular1BarOutlined]
            ["@material-ui/icons/SignalCellular1BarRounded" :default SignalCellular1BarRounded]
            ["@material-ui/icons/SignalCellular1BarSharp" :default SignalCellular1BarSharp]
            ["@material-ui/icons/SignalCellular1BarTwoTone" :default SignalCellular1BarTwoTone]
            ["@material-ui/icons/SignalCellular2Bar" :default SignalCellular2Bar]
            ["@material-ui/icons/SignalCellular2BarOutlined" :default SignalCellular2BarOutlined]
            ["@material-ui/icons/SignalCellular2BarRounded" :default SignalCellular2BarRounded]
            ["@material-ui/icons/SignalCellular2BarSharp" :default SignalCellular2BarSharp]
            ["@material-ui/icons/SignalCellular2BarTwoTone" :default SignalCellular2BarTwoTone]
            ["@material-ui/icons/SignalCellular3Bar" :default SignalCellular3Bar]
            ["@material-ui/icons/SignalCellular3BarOutlined" :default SignalCellular3BarOutlined]
            ["@material-ui/icons/SignalCellular3BarRounded" :default SignalCellular3BarRounded]
            ["@material-ui/icons/SignalCellular3BarSharp" :default SignalCellular3BarSharp]
            ["@material-ui/icons/SignalCellular3BarTwoTone" :default SignalCellular3BarTwoTone]
            ["@material-ui/icons/SignalCellular4Bar" :default SignalCellular4Bar]
            ["@material-ui/icons/SignalCellular4BarOutlined" :default SignalCellular4BarOutlined]
            ["@material-ui/icons/SignalCellular4BarRounded" :default SignalCellular4BarRounded]
            ["@material-ui/icons/SignalCellular4BarSharp" :default SignalCellular4BarSharp]
            ["@material-ui/icons/SignalCellular4BarTwoTone" :default SignalCellular4BarTwoTone]
            ["@material-ui/icons/SignalCellularAlt" :default SignalCellularAlt]
            ["@material-ui/icons/SignalCellularAltOutlined" :default SignalCellularAltOutlined]
            ["@material-ui/icons/SignalCellularAltRounded" :default SignalCellularAltRounded]
            ["@material-ui/icons/SignalCellularAltSharp" :default SignalCellularAltSharp]
            ["@material-ui/icons/SignalCellularAltTwoTone" :default SignalCellularAltTwoTone]
            ["@material-ui/icons/SignalCellularConnectedNoInternet0Bar" :default SignalCellularConnectedNoInternet0Bar]
            ["@material-ui/icons/SignalCellularConnectedNoInternet0BarOutlined" :default SignalCellularConnectedNoInternet0BarOutlined]
            ["@material-ui/icons/SignalCellularConnectedNoInternet0BarRounded" :default SignalCellularConnectedNoInternet0BarRounded]
            ["@material-ui/icons/SignalCellularConnectedNoInternet0BarSharp" :default SignalCellularConnectedNoInternet0BarSharp]
            ["@material-ui/icons/SignalCellularConnectedNoInternet0BarTwoTone" :default SignalCellularConnectedNoInternet0BarTwoTone]
            ["@material-ui/icons/SignalCellularConnectedNoInternet1Bar" :default SignalCellularConnectedNoInternet1Bar]
            ["@material-ui/icons/SignalCellularConnectedNoInternet1BarOutlined" :default SignalCellularConnectedNoInternet1BarOutlined]
            ["@material-ui/icons/SignalCellularConnectedNoInternet1BarRounded" :default SignalCellularConnectedNoInternet1BarRounded]
            ["@material-ui/icons/SignalCellularConnectedNoInternet1BarSharp" :default SignalCellularConnectedNoInternet1BarSharp]
            ["@material-ui/icons/SignalCellularConnectedNoInternet1BarTwoTone" :default SignalCellularConnectedNoInternet1BarTwoTone]
            ["@material-ui/icons/SignalCellularConnectedNoInternet2Bar" :default SignalCellularConnectedNoInternet2Bar]
            ["@material-ui/icons/SignalCellularConnectedNoInternet2BarOutlined" :default SignalCellularConnectedNoInternet2BarOutlined]
            ["@material-ui/icons/SignalCellularConnectedNoInternet2BarRounded" :default SignalCellularConnectedNoInternet2BarRounded]
            ["@material-ui/icons/SignalCellularConnectedNoInternet2BarSharp" :default SignalCellularConnectedNoInternet2BarSharp]
            ["@material-ui/icons/SignalCellularConnectedNoInternet2BarTwoTone" :default SignalCellularConnectedNoInternet2BarTwoTone]
            ["@material-ui/icons/SignalCellularConnectedNoInternet3Bar" :default SignalCellularConnectedNoInternet3Bar]
            ["@material-ui/icons/SignalCellularConnectedNoInternet3BarOutlined" :default SignalCellularConnectedNoInternet3BarOutlined]
            ["@material-ui/icons/SignalCellularConnectedNoInternet3BarRounded" :default SignalCellularConnectedNoInternet3BarRounded]
            ["@material-ui/icons/SignalCellularConnectedNoInternet3BarSharp" :default SignalCellularConnectedNoInternet3BarSharp]
            ["@material-ui/icons/SignalCellularConnectedNoInternet3BarTwoTone" :default SignalCellularConnectedNoInternet3BarTwoTone]
            ["@material-ui/icons/SignalCellularConnectedNoInternet4Bar" :default SignalCellularConnectedNoInternet4Bar]
            ["@material-ui/icons/SignalCellularConnectedNoInternet4BarOutlined" :default SignalCellularConnectedNoInternet4BarOutlined]
            ["@material-ui/icons/SignalCellularConnectedNoInternet4BarRounded" :default SignalCellularConnectedNoInternet4BarRounded]
            ["@material-ui/icons/SignalCellularConnectedNoInternet4BarSharp" :default SignalCellularConnectedNoInternet4BarSharp]
            ["@material-ui/icons/SignalCellularConnectedNoInternet4BarTwoTone" :default SignalCellularConnectedNoInternet4BarTwoTone]
            ["@material-ui/icons/SignalCellularNoSim" :default SignalCellularNoSim]
            ["@material-ui/icons/SignalCellularNoSimOutlined" :default SignalCellularNoSimOutlined]
            ["@material-ui/icons/SignalCellularNoSimRounded" :default SignalCellularNoSimRounded]
            ["@material-ui/icons/SignalCellularNoSimSharp" :default SignalCellularNoSimSharp]
            ["@material-ui/icons/SignalCellularNoSimTwoTone" :default SignalCellularNoSimTwoTone]
            ["@material-ui/icons/SignalCellularNull" :default SignalCellularNull]
            ["@material-ui/icons/SignalCellularNullOutlined" :default SignalCellularNullOutlined]
            ["@material-ui/icons/SignalCellularNullRounded" :default SignalCellularNullRounded]
            ["@material-ui/icons/SignalCellularNullSharp" :default SignalCellularNullSharp]
            ["@material-ui/icons/SignalCellularNullTwoTone" :default SignalCellularNullTwoTone]
            ["@material-ui/icons/SignalCellularOff" :default SignalCellularOff]
            ["@material-ui/icons/SignalCellularOffOutlined" :default SignalCellularOffOutlined]
            ["@material-ui/icons/SignalCellularOffRounded" :default SignalCellularOffRounded]
            ["@material-ui/icons/SignalCellularOffSharp" :default SignalCellularOffSharp]
            ["@material-ui/icons/SignalCellularOffTwoTone" :default SignalCellularOffTwoTone]
            ["@material-ui/icons/SignalWifi0Bar" :default SignalWifi0Bar]
            ["@material-ui/icons/SignalWifi0BarOutlined" :default SignalWifi0BarOutlined]
            ["@material-ui/icons/SignalWifi0BarRounded" :default SignalWifi0BarRounded]
            ["@material-ui/icons/SignalWifi0BarSharp" :default SignalWifi0BarSharp]
            ["@material-ui/icons/SignalWifi0BarTwoTone" :default SignalWifi0BarTwoTone]
            ["@material-ui/icons/SignalWifi1Bar" :default SignalWifi1Bar]
            ["@material-ui/icons/SignalWifi1BarLock" :default SignalWifi1BarLock]
            ["@material-ui/icons/SignalWifi1BarLockOutlined" :default SignalWifi1BarLockOutlined]
            ["@material-ui/icons/SignalWifi1BarLockRounded" :default SignalWifi1BarLockRounded]
            ["@material-ui/icons/SignalWifi1BarLockSharp" :default SignalWifi1BarLockSharp]
            ["@material-ui/icons/SignalWifi1BarLockTwoTone" :default SignalWifi1BarLockTwoTone]
            ["@material-ui/icons/SignalWifi1BarOutlined" :default SignalWifi1BarOutlined]
            ["@material-ui/icons/SignalWifi1BarRounded" :default SignalWifi1BarRounded]
            ["@material-ui/icons/SignalWifi1BarSharp" :default SignalWifi1BarSharp]
            ["@material-ui/icons/SignalWifi1BarTwoTone" :default SignalWifi1BarTwoTone]
            ["@material-ui/icons/SignalWifi2Bar" :default SignalWifi2Bar]
            ["@material-ui/icons/SignalWifi2BarLock" :default SignalWifi2BarLock]
            ["@material-ui/icons/SignalWifi2BarLockOutlined" :default SignalWifi2BarLockOutlined]
            ["@material-ui/icons/SignalWifi2BarLockRounded" :default SignalWifi2BarLockRounded]
            ["@material-ui/icons/SignalWifi2BarLockSharp" :default SignalWifi2BarLockSharp]
            ["@material-ui/icons/SignalWifi2BarLockTwoTone" :default SignalWifi2BarLockTwoTone]
            ["@material-ui/icons/SignalWifi2BarOutlined" :default SignalWifi2BarOutlined]
            ["@material-ui/icons/SignalWifi2BarRounded" :default SignalWifi2BarRounded]
            ["@material-ui/icons/SignalWifi2BarSharp" :default SignalWifi2BarSharp]
            ["@material-ui/icons/SignalWifi2BarTwoTone" :default SignalWifi2BarTwoTone]
            ["@material-ui/icons/SignalWifi3Bar" :default SignalWifi3Bar]
            ["@material-ui/icons/SignalWifi3BarLock" :default SignalWifi3BarLock]
            ["@material-ui/icons/SignalWifi3BarLockOutlined" :default SignalWifi3BarLockOutlined]
            ["@material-ui/icons/SignalWifi3BarLockRounded" :default SignalWifi3BarLockRounded]
            ["@material-ui/icons/SignalWifi3BarLockSharp" :default SignalWifi3BarLockSharp]
            ["@material-ui/icons/SignalWifi3BarLockTwoTone" :default SignalWifi3BarLockTwoTone]
            ["@material-ui/icons/SignalWifi3BarOutlined" :default SignalWifi3BarOutlined]
            ["@material-ui/icons/SignalWifi3BarRounded" :default SignalWifi3BarRounded]
            ["@material-ui/icons/SignalWifi3BarSharp" :default SignalWifi3BarSharp]
            ["@material-ui/icons/SignalWifi3BarTwoTone" :default SignalWifi3BarTwoTone]
            ["@material-ui/icons/SignalWifi4Bar" :default SignalWifi4Bar]
            ["@material-ui/icons/SignalWifi4BarLock" :default SignalWifi4BarLock]
            ["@material-ui/icons/SignalWifi4BarLockOutlined" :default SignalWifi4BarLockOutlined]
            ["@material-ui/icons/SignalWifi4BarLockRounded" :default SignalWifi4BarLockRounded]
            ["@material-ui/icons/SignalWifi4BarLockSharp" :default SignalWifi4BarLockSharp]
            ["@material-ui/icons/SignalWifi4BarLockTwoTone" :default SignalWifi4BarLockTwoTone]
            ["@material-ui/icons/SignalWifi4BarOutlined" :default SignalWifi4BarOutlined]
            ["@material-ui/icons/SignalWifi4BarRounded" :default SignalWifi4BarRounded]
            ["@material-ui/icons/SignalWifi4BarSharp" :default SignalWifi4BarSharp]
            ["@material-ui/icons/SignalWifi4BarTwoTone" :default SignalWifi4BarTwoTone]
            ["@material-ui/icons/SignalWifiOff" :default SignalWifiOff]
            ["@material-ui/icons/SignalWifiOffOutlined" :default SignalWifiOffOutlined]
            ["@material-ui/icons/SignalWifiOffRounded" :default SignalWifiOffRounded]
            ["@material-ui/icons/SignalWifiOffSharp" :default SignalWifiOffSharp]
            ["@material-ui/icons/SignalWifiOffTwoTone" :default SignalWifiOffTwoTone]
            ["@material-ui/icons/SimCard" :default SimCard]
            ["@material-ui/icons/SimCardOutlined" :default SimCardOutlined]
            ["@material-ui/icons/SimCardRounded" :default SimCardRounded]
            ["@material-ui/icons/SimCardSharp" :default SimCardSharp]
            ["@material-ui/icons/SimCardTwoTone" :default SimCardTwoTone]
            ["@material-ui/icons/SingleBed" :default SingleBed]
            ["@material-ui/icons/SingleBedOutlined" :default SingleBedOutlined]
            ["@material-ui/icons/SingleBedRounded" :default SingleBedRounded]
            ["@material-ui/icons/SingleBedSharp" :default SingleBedSharp]
            ["@material-ui/icons/SingleBedTwoTone" :default SingleBedTwoTone]
            ["@material-ui/icons/SkipNext" :default SkipNext]
            ["@material-ui/icons/SkipNextOutlined" :default SkipNextOutlined]
            ["@material-ui/icons/SkipNextRounded" :default SkipNextRounded]
            ["@material-ui/icons/SkipNextSharp" :default SkipNextSharp]
            ["@material-ui/icons/SkipNextTwoTone" :default SkipNextTwoTone]
            ["@material-ui/icons/SkipPrevious" :default SkipPrevious]
            ["@material-ui/icons/SkipPreviousOutlined" :default SkipPreviousOutlined]
            ["@material-ui/icons/SkipPreviousRounded" :default SkipPreviousRounded]
            ["@material-ui/icons/SkipPreviousSharp" :default SkipPreviousSharp]
            ["@material-ui/icons/SkipPreviousTwoTone" :default SkipPreviousTwoTone]
            ["@material-ui/icons/Slideshow" :default Slideshow]
            ["@material-ui/icons/SlideshowOutlined" :default SlideshowOutlined]
            ["@material-ui/icons/SlideshowRounded" :default SlideshowRounded]
            ["@material-ui/icons/SlideshowSharp" :default SlideshowSharp]
            ["@material-ui/icons/SlideshowTwoTone" :default SlideshowTwoTone]
            ["@material-ui/icons/SlowMotionVideo" :default SlowMotionVideo]
            ["@material-ui/icons/SlowMotionVideoOutlined" :default SlowMotionVideoOutlined]
            ["@material-ui/icons/SlowMotionVideoRounded" :default SlowMotionVideoRounded]
            ["@material-ui/icons/SlowMotionVideoSharp" :default SlowMotionVideoSharp]
            ["@material-ui/icons/SlowMotionVideoTwoTone" :default SlowMotionVideoTwoTone]
            ["@material-ui/icons/Smartphone" :default Smartphone]
            ["@material-ui/icons/SmartphoneOutlined" :default SmartphoneOutlined]
            ["@material-ui/icons/SmartphoneRounded" :default SmartphoneRounded]
            ["@material-ui/icons/SmartphoneSharp" :default SmartphoneSharp]
            ["@material-ui/icons/SmartphoneTwoTone" :default SmartphoneTwoTone]
            ["@material-ui/icons/SmokeFree" :default SmokeFree]
            ["@material-ui/icons/SmokeFreeOutlined" :default SmokeFreeOutlined]
            ["@material-ui/icons/SmokeFreeRounded" :default SmokeFreeRounded]
            ["@material-ui/icons/SmokeFreeSharp" :default SmokeFreeSharp]
            ["@material-ui/icons/SmokeFreeTwoTone" :default SmokeFreeTwoTone]
            ["@material-ui/icons/SmokingRooms" :default SmokingRooms]
            ["@material-ui/icons/SmokingRoomsOutlined" :default SmokingRoomsOutlined]
            ["@material-ui/icons/SmokingRoomsRounded" :default SmokingRoomsRounded]
            ["@material-ui/icons/SmokingRoomsSharp" :default SmokingRoomsSharp]
            ["@material-ui/icons/SmokingRoomsTwoTone" :default SmokingRoomsTwoTone]
            ["@material-ui/icons/Sms" :default Sms]
            ["@material-ui/icons/SmsFailed" :default SmsFailed]
            ["@material-ui/icons/SmsFailedOutlined" :default SmsFailedOutlined]
            ["@material-ui/icons/SmsFailedRounded" :default SmsFailedRounded]
            ["@material-ui/icons/SmsFailedSharp" :default SmsFailedSharp]
            ["@material-ui/icons/SmsFailedTwoTone" :default SmsFailedTwoTone]
            ["@material-ui/icons/SmsOutlined" :default SmsOutlined]
            ["@material-ui/icons/SmsRounded" :default SmsRounded]
            ["@material-ui/icons/SmsSharp" :default SmsSharp]
            ["@material-ui/icons/SmsTwoTone" :default SmsTwoTone]
            ["@material-ui/icons/Snooze" :default Snooze]
            ["@material-ui/icons/SnoozeOutlined" :default SnoozeOutlined]
            ["@material-ui/icons/SnoozeRounded" :default SnoozeRounded]
            ["@material-ui/icons/SnoozeSharp" :default SnoozeSharp]
            ["@material-ui/icons/SnoozeTwoTone" :default SnoozeTwoTone]
            ["@material-ui/icons/Sort" :default Sort]
            ["@material-ui/icons/SortByAlpha" :default SortByAlpha]
            ["@material-ui/icons/SortByAlphaOutlined" :default SortByAlphaOutlined]
            ["@material-ui/icons/SortByAlphaRounded" :default SortByAlphaRounded]
            ["@material-ui/icons/SortByAlphaSharp" :default SortByAlphaSharp]
            ["@material-ui/icons/SortByAlphaTwoTone" :default SortByAlphaTwoTone]
            ["@material-ui/icons/SortOutlined" :default SortOutlined]
            ["@material-ui/icons/SortRounded" :default SortRounded]
            ["@material-ui/icons/SortSharp" :default SortSharp]
            ["@material-ui/icons/SortTwoTone" :default SortTwoTone]
            ["@material-ui/icons/Spa" :default Spa]
            ["@material-ui/icons/SpaceBar" :default SpaceBar]
            ["@material-ui/icons/SpaceBarOutlined" :default SpaceBarOutlined]
            ["@material-ui/icons/SpaceBarRounded" :default SpaceBarRounded]
            ["@material-ui/icons/SpaceBarSharp" :default SpaceBarSharp]
            ["@material-ui/icons/SpaceBarTwoTone" :default SpaceBarTwoTone]
            ["@material-ui/icons/SpaOutlined" :default SpaOutlined]
            ["@material-ui/icons/SpaRounded" :default SpaRounded]
            ["@material-ui/icons/SpaSharp" :default SpaSharp]
            ["@material-ui/icons/SpaTwoTone" :default SpaTwoTone]
            ["@material-ui/icons/Speaker" :default Speaker]
            ["@material-ui/icons/SpeakerGroup" :default SpeakerGroup]
            ["@material-ui/icons/SpeakerGroupOutlined" :default SpeakerGroupOutlined]
            ["@material-ui/icons/SpeakerGroupRounded" :default SpeakerGroupRounded]
            ["@material-ui/icons/SpeakerGroupSharp" :default SpeakerGroupSharp]
            ["@material-ui/icons/SpeakerGroupTwoTone" :default SpeakerGroupTwoTone]
            ["@material-ui/icons/SpeakerNotes" :default SpeakerNotes]
            ["@material-ui/icons/SpeakerNotesOff" :default SpeakerNotesOff]
            ["@material-ui/icons/SpeakerNotesOffOutlined" :default SpeakerNotesOffOutlined]
            ["@material-ui/icons/SpeakerNotesOffRounded" :default SpeakerNotesOffRounded]
            ["@material-ui/icons/SpeakerNotesOffSharp" :default SpeakerNotesOffSharp]
            ["@material-ui/icons/SpeakerNotesOffTwoTone" :default SpeakerNotesOffTwoTone]
            ["@material-ui/icons/SpeakerNotesOutlined" :default SpeakerNotesOutlined]
            ["@material-ui/icons/SpeakerNotesRounded" :default SpeakerNotesRounded]
            ["@material-ui/icons/SpeakerNotesSharp" :default SpeakerNotesSharp]
            ["@material-ui/icons/SpeakerNotesTwoTone" :default SpeakerNotesTwoTone]
            ["@material-ui/icons/SpeakerOutlined" :default SpeakerOutlined]
            ["@material-ui/icons/SpeakerPhone" :default SpeakerPhone]
            ["@material-ui/icons/SpeakerPhoneOutlined" :default SpeakerPhoneOutlined]
            ["@material-ui/icons/SpeakerPhoneRounded" :default SpeakerPhoneRounded]
            ["@material-ui/icons/SpeakerPhoneSharp" :default SpeakerPhoneSharp]
            ["@material-ui/icons/SpeakerPhoneTwoTone" :default SpeakerPhoneTwoTone]
            ["@material-ui/icons/SpeakerRounded" :default SpeakerRounded]
            ["@material-ui/icons/SpeakerSharp" :default SpeakerSharp]
            ["@material-ui/icons/SpeakerTwoTone" :default SpeakerTwoTone]
            ["@material-ui/icons/Speed" :default Speed]
            ["@material-ui/icons/SpeedOutlined" :default SpeedOutlined]
            ["@material-ui/icons/SpeedRounded" :default SpeedRounded]
            ["@material-ui/icons/SpeedSharp" :default SpeedSharp]
            ["@material-ui/icons/SpeedTwoTone" :default SpeedTwoTone]
            ["@material-ui/icons/Spellcheck" :default Spellcheck]
            ["@material-ui/icons/SpellcheckOutlined" :default SpellcheckOutlined]
            ["@material-ui/icons/SpellcheckRounded" :default SpellcheckRounded]
            ["@material-ui/icons/SpellcheckSharp" :default SpellcheckSharp]
            ["@material-ui/icons/SpellcheckTwoTone" :default SpellcheckTwoTone]
            ["@material-ui/icons/Sports" :default Sports]
            ["@material-ui/icons/SportsBaseball" :default SportsBaseball]
            ["@material-ui/icons/SportsBaseballOutlined" :default SportsBaseballOutlined]
            ["@material-ui/icons/SportsBaseballRounded" :default SportsBaseballRounded]
            ["@material-ui/icons/SportsBaseballSharp" :default SportsBaseballSharp]
            ["@material-ui/icons/SportsBaseballTwoTone" :default SportsBaseballTwoTone]
            ["@material-ui/icons/SportsBasketball" :default SportsBasketball]
            ["@material-ui/icons/SportsBasketballOutlined" :default SportsBasketballOutlined]
            ["@material-ui/icons/SportsBasketballRounded" :default SportsBasketballRounded]
            ["@material-ui/icons/SportsBasketballSharp" :default SportsBasketballSharp]
            ["@material-ui/icons/SportsBasketballTwoTone" :default SportsBasketballTwoTone]
            ["@material-ui/icons/SportsCricket" :default SportsCricket]
            ["@material-ui/icons/SportsCricketOutlined" :default SportsCricketOutlined]
            ["@material-ui/icons/SportsCricketRounded" :default SportsCricketRounded]
            ["@material-ui/icons/SportsCricketSharp" :default SportsCricketSharp]
            ["@material-ui/icons/SportsCricketTwoTone" :default SportsCricketTwoTone]
            ["@material-ui/icons/SportsEsports" :default SportsEsports]
            ["@material-ui/icons/SportsEsportsOutlined" :default SportsEsportsOutlined]
            ["@material-ui/icons/SportsEsportsRounded" :default SportsEsportsRounded]
            ["@material-ui/icons/SportsEsportsSharp" :default SportsEsportsSharp]
            ["@material-ui/icons/SportsEsportsTwoTone" :default SportsEsportsTwoTone]
            ["@material-ui/icons/SportsFootball" :default SportsFootball]
            ["@material-ui/icons/SportsFootballOutlined" :default SportsFootballOutlined]
            ["@material-ui/icons/SportsFootballRounded" :default SportsFootballRounded]
            ["@material-ui/icons/SportsFootballSharp" :default SportsFootballSharp]
            ["@material-ui/icons/SportsFootballTwoTone" :default SportsFootballTwoTone]
            ["@material-ui/icons/SportsGolf" :default SportsGolf]
            ["@material-ui/icons/SportsGolfOutlined" :default SportsGolfOutlined]
            ["@material-ui/icons/SportsGolfRounded" :default SportsGolfRounded]
            ["@material-ui/icons/SportsGolfSharp" :default SportsGolfSharp]
            ["@material-ui/icons/SportsGolfTwoTone" :default SportsGolfTwoTone]
            ["@material-ui/icons/SportsHandball" :default SportsHandball]
            ["@material-ui/icons/SportsHandballOutlined" :default SportsHandballOutlined]
            ["@material-ui/icons/SportsHandballRounded" :default SportsHandballRounded]
            ["@material-ui/icons/SportsHandballSharp" :default SportsHandballSharp]
            ["@material-ui/icons/SportsHandballTwoTone" :default SportsHandballTwoTone]
            ["@material-ui/icons/SportsHockey" :default SportsHockey]
            ["@material-ui/icons/SportsHockeyOutlined" :default SportsHockeyOutlined]
            ["@material-ui/icons/SportsHockeyRounded" :default SportsHockeyRounded]
            ["@material-ui/icons/SportsHockeySharp" :default SportsHockeySharp]
            ["@material-ui/icons/SportsHockeyTwoTone" :default SportsHockeyTwoTone]
            ["@material-ui/icons/SportsKabaddi" :default SportsKabaddi]
            ["@material-ui/icons/SportsKabaddiOutlined" :default SportsKabaddiOutlined]
            ["@material-ui/icons/SportsKabaddiRounded" :default SportsKabaddiRounded]
            ["@material-ui/icons/SportsKabaddiSharp" :default SportsKabaddiSharp]
            ["@material-ui/icons/SportsKabaddiTwoTone" :default SportsKabaddiTwoTone]
            ["@material-ui/icons/SportsMma" :default SportsMma]
            ["@material-ui/icons/SportsMmaOutlined" :default SportsMmaOutlined]
            ["@material-ui/icons/SportsMmaRounded" :default SportsMmaRounded]
            ["@material-ui/icons/SportsMmaSharp" :default SportsMmaSharp]
            ["@material-ui/icons/SportsMmaTwoTone" :default SportsMmaTwoTone]
            ["@material-ui/icons/SportsMotorsports" :default SportsMotorsports]
            ["@material-ui/icons/SportsMotorsportsOutlined" :default SportsMotorsportsOutlined]
            ["@material-ui/icons/SportsMotorsportsRounded" :default SportsMotorsportsRounded]
            ["@material-ui/icons/SportsMotorsportsSharp" :default SportsMotorsportsSharp]
            ["@material-ui/icons/SportsMotorsportsTwoTone" :default SportsMotorsportsTwoTone]
            ["@material-ui/icons/SportsOutlined" :default SportsOutlined]
            ["@material-ui/icons/SportsRounded" :default SportsRounded]
            ["@material-ui/icons/SportsRugby" :default SportsRugby]
            ["@material-ui/icons/SportsRugbyOutlined" :default SportsRugbyOutlined]
            ["@material-ui/icons/SportsRugbyRounded" :default SportsRugbyRounded]
            ["@material-ui/icons/SportsRugbySharp" :default SportsRugbySharp]
            ["@material-ui/icons/SportsRugbyTwoTone" :default SportsRugbyTwoTone]
            ["@material-ui/icons/SportsSharp" :default SportsSharp]
            ["@material-ui/icons/SportsSoccer" :default SportsSoccer]
            ["@material-ui/icons/SportsSoccerOutlined" :default SportsSoccerOutlined]
            ["@material-ui/icons/SportsSoccerRounded" :default SportsSoccerRounded]
            ["@material-ui/icons/SportsSoccerSharp" :default SportsSoccerSharp]
            ["@material-ui/icons/SportsSoccerTwoTone" :default SportsSoccerTwoTone]
            ["@material-ui/icons/SportsTennis" :default SportsTennis]
            ["@material-ui/icons/SportsTennisOutlined" :default SportsTennisOutlined]
            ["@material-ui/icons/SportsTennisRounded" :default SportsTennisRounded]
            ["@material-ui/icons/SportsTennisSharp" :default SportsTennisSharp]
            ["@material-ui/icons/SportsTennisTwoTone" :default SportsTennisTwoTone]
            ["@material-ui/icons/SportsTwoTone" :default SportsTwoTone]
            ["@material-ui/icons/SportsVolleyball" :default SportsVolleyball]
            ["@material-ui/icons/SportsVolleyballOutlined" :default SportsVolleyballOutlined]
            ["@material-ui/icons/SportsVolleyballRounded" :default SportsVolleyballRounded]
            ["@material-ui/icons/SportsVolleyballSharp" :default SportsVolleyballSharp]
            ["@material-ui/icons/SportsVolleyballTwoTone" :default SportsVolleyballTwoTone]
            ["@material-ui/icons/SquareFoot" :default SquareFoot]
            ["@material-ui/icons/SquareFootOutlined" :default SquareFootOutlined]
            ["@material-ui/icons/SquareFootRounded" :default SquareFootRounded]
            ["@material-ui/icons/SquareFootSharp" :default SquareFootSharp]
            ["@material-ui/icons/SquareFootTwoTone" :default SquareFootTwoTone]
            ["@material-ui/icons/Star" :default Star]
            ["@material-ui/icons/StarBorder" :default StarBorder]
            ["@material-ui/icons/StarBorderOutlined" :default StarBorderOutlined]
            ["@material-ui/icons/StarBorderRounded" :default StarBorderRounded]
            ["@material-ui/icons/StarBorderSharp" :default StarBorderSharp]
            ["@material-ui/icons/StarBorderTwoTone" :default StarBorderTwoTone]
            ["@material-ui/icons/StarHalf" :default StarHalf]
            ["@material-ui/icons/StarHalfOutlined" :default StarHalfOutlined]
            ["@material-ui/icons/StarHalfRounded" :default StarHalfRounded]
            ["@material-ui/icons/StarHalfSharp" :default StarHalfSharp]
            ["@material-ui/icons/StarHalfTwoTone" :default StarHalfTwoTone]
            ["@material-ui/icons/StarRate" :default StarRate]
            ["@material-ui/icons/StarRateOutlined" :default StarRateOutlined]
            ["@material-ui/icons/StarRateRounded" :default StarRateRounded]
            ["@material-ui/icons/StarRateSharp" :default StarRateSharp]
            ["@material-ui/icons/StarRateTwoTone" :default StarRateTwoTone]
            ["@material-ui/icons/StarRounded" :default StarRounded]
            ["@material-ui/icons/Stars" :default Stars]
            ["@material-ui/icons/StarSharp" :default StarSharp]
            ["@material-ui/icons/StarsOutlined" :default StarsOutlined]
            ["@material-ui/icons/StarsRounded" :default StarsRounded]
            ["@material-ui/icons/StarsSharp" :default StarsSharp]
            ["@material-ui/icons/StarsTwoTone" :default StarsTwoTone]
            ["@material-ui/icons/StarTwoTone" :default StarTwoTone]
            ["@material-ui/icons/StayCurrentLandscape" :default StayCurrentLandscape]
            ["@material-ui/icons/StayCurrentLandscapeOutlined" :default StayCurrentLandscapeOutlined]
            ["@material-ui/icons/StayCurrentLandscapeRounded" :default StayCurrentLandscapeRounded]
            ["@material-ui/icons/StayCurrentLandscapeSharp" :default StayCurrentLandscapeSharp]
            ["@material-ui/icons/StayCurrentLandscapeTwoTone" :default StayCurrentLandscapeTwoTone]
            ["@material-ui/icons/StayCurrentPortrait" :default StayCurrentPortrait]
            ["@material-ui/icons/StayCurrentPortraitOutlined" :default StayCurrentPortraitOutlined]
            ["@material-ui/icons/StayCurrentPortraitRounded" :default StayCurrentPortraitRounded]
            ["@material-ui/icons/StayCurrentPortraitSharp" :default StayCurrentPortraitSharp]
            ["@material-ui/icons/StayCurrentPortraitTwoTone" :default StayCurrentPortraitTwoTone]
            ["@material-ui/icons/StayPrimaryLandscape" :default StayPrimaryLandscape]
            ["@material-ui/icons/StayPrimaryLandscapeOutlined" :default StayPrimaryLandscapeOutlined]
            ["@material-ui/icons/StayPrimaryLandscapeRounded" :default StayPrimaryLandscapeRounded]
            ["@material-ui/icons/StayPrimaryLandscapeSharp" :default StayPrimaryLandscapeSharp]
            ["@material-ui/icons/StayPrimaryLandscapeTwoTone" :default StayPrimaryLandscapeTwoTone]
            ["@material-ui/icons/StayPrimaryPortrait" :default StayPrimaryPortrait]
            ["@material-ui/icons/StayPrimaryPortraitOutlined" :default StayPrimaryPortraitOutlined]
            ["@material-ui/icons/StayPrimaryPortraitRounded" :default StayPrimaryPortraitRounded]
            ["@material-ui/icons/StayPrimaryPortraitSharp" :default StayPrimaryPortraitSharp]
            ["@material-ui/icons/StayPrimaryPortraitTwoTone" :default StayPrimaryPortraitTwoTone]
            ["@material-ui/icons/Stop" :default Stop]
            ["@material-ui/icons/StopOutlined" :default StopOutlined]
            ["@material-ui/icons/StopRounded" :default StopRounded]
            ["@material-ui/icons/StopScreenShare" :default StopScreenShare]
            ["@material-ui/icons/StopScreenShareOutlined" :default StopScreenShareOutlined]
            ["@material-ui/icons/StopScreenShareRounded" :default StopScreenShareRounded]
            ["@material-ui/icons/StopScreenShareSharp" :default StopScreenShareSharp]
            ["@material-ui/icons/StopScreenShareTwoTone" :default StopScreenShareTwoTone]
            ["@material-ui/icons/StopSharp" :default StopSharp]
            ["@material-ui/icons/StopTwoTone" :default StopTwoTone]
            ["@material-ui/icons/Storage" :default Storage]
            ["@material-ui/icons/StorageOutlined" :default StorageOutlined]
            ["@material-ui/icons/StorageRounded" :default StorageRounded]
            ["@material-ui/icons/StorageSharp" :default StorageSharp]
            ["@material-ui/icons/StorageTwoTone" :default StorageTwoTone]
            ["@material-ui/icons/Store" :default Store]
            ["@material-ui/icons/Storefront" :default Storefront]
            ["@material-ui/icons/StorefrontOutlined" :default StorefrontOutlined]
            ["@material-ui/icons/StorefrontRounded" :default StorefrontRounded]
            ["@material-ui/icons/StorefrontSharp" :default StorefrontSharp]
            ["@material-ui/icons/StorefrontTwoTone" :default StorefrontTwoTone]
            ["@material-ui/icons/StoreMallDirectory" :default StoreMallDirectory]
            ["@material-ui/icons/StoreMallDirectoryOutlined" :default StoreMallDirectoryOutlined]
            ["@material-ui/icons/StoreMallDirectoryRounded" :default StoreMallDirectoryRounded]
            ["@material-ui/icons/StoreMallDirectorySharp" :default StoreMallDirectorySharp]
            ["@material-ui/icons/StoreMallDirectoryTwoTone" :default StoreMallDirectoryTwoTone]
            ["@material-ui/icons/StoreOutlined" :default StoreOutlined]
            ["@material-ui/icons/StoreRounded" :default StoreRounded]
            ["@material-ui/icons/StoreSharp" :default StoreSharp]
            ["@material-ui/icons/StoreTwoTone" :default StoreTwoTone]
            ["@material-ui/icons/Straighten" :default Straighten]
            ["@material-ui/icons/StraightenOutlined" :default StraightenOutlined]
            ["@material-ui/icons/StraightenRounded" :default StraightenRounded]
            ["@material-ui/icons/StraightenSharp" :default StraightenSharp]
            ["@material-ui/icons/StraightenTwoTone" :default StraightenTwoTone]
            ["@material-ui/icons/Streetview" :default Streetview]
            ["@material-ui/icons/StreetviewOutlined" :default StreetviewOutlined]
            ["@material-ui/icons/StreetviewRounded" :default StreetviewRounded]
            ["@material-ui/icons/StreetviewSharp" :default StreetviewSharp]
            ["@material-ui/icons/StreetviewTwoTone" :default StreetviewTwoTone]
            ["@material-ui/icons/StrikethroughS" :default StrikethroughS]
            ["@material-ui/icons/StrikethroughSOutlined" :default StrikethroughSOutlined]
            ["@material-ui/icons/StrikethroughSRounded" :default StrikethroughSRounded]
            ["@material-ui/icons/StrikethroughSSharp" :default StrikethroughSSharp]
            ["@material-ui/icons/StrikethroughSTwoTone" :default StrikethroughSTwoTone]
            ["@material-ui/icons/Style" :default Style]
            ["@material-ui/icons/StyleOutlined" :default StyleOutlined]
            ["@material-ui/icons/StyleRounded" :default StyleRounded]
            ["@material-ui/icons/StyleSharp" :default StyleSharp]
            ["@material-ui/icons/StyleTwoTone" :default StyleTwoTone]
            ["@material-ui/icons/SubdirectoryArrowLeft" :default SubdirectoryArrowLeft]
            ["@material-ui/icons/SubdirectoryArrowLeftOutlined" :default SubdirectoryArrowLeftOutlined]
            ["@material-ui/icons/SubdirectoryArrowLeftRounded" :default SubdirectoryArrowLeftRounded]
            ["@material-ui/icons/SubdirectoryArrowLeftSharp" :default SubdirectoryArrowLeftSharp]
            ["@material-ui/icons/SubdirectoryArrowLeftTwoTone" :default SubdirectoryArrowLeftTwoTone]
            ["@material-ui/icons/SubdirectoryArrowRight" :default SubdirectoryArrowRight]
            ["@material-ui/icons/SubdirectoryArrowRightOutlined" :default SubdirectoryArrowRightOutlined]
            ["@material-ui/icons/SubdirectoryArrowRightRounded" :default SubdirectoryArrowRightRounded]
            ["@material-ui/icons/SubdirectoryArrowRightSharp" :default SubdirectoryArrowRightSharp]
            ["@material-ui/icons/SubdirectoryArrowRightTwoTone" :default SubdirectoryArrowRightTwoTone]
            ["@material-ui/icons/Subject" :default Subject]
            ["@material-ui/icons/SubjectOutlined" :default SubjectOutlined]
            ["@material-ui/icons/SubjectRounded" :default SubjectRounded]
            ["@material-ui/icons/SubjectSharp" :default SubjectSharp]
            ["@material-ui/icons/SubjectTwoTone" :default SubjectTwoTone]
            ["@material-ui/icons/Subscriptions" :default Subscriptions]
            ["@material-ui/icons/SubscriptionsOutlined" :default SubscriptionsOutlined]
            ["@material-ui/icons/SubscriptionsRounded" :default SubscriptionsRounded]
            ["@material-ui/icons/SubscriptionsSharp" :default SubscriptionsSharp]
            ["@material-ui/icons/SubscriptionsTwoTone" :default SubscriptionsTwoTone]
            ["@material-ui/icons/Subtitles" :default Subtitles]
            ["@material-ui/icons/SubtitlesOutlined" :default SubtitlesOutlined]
            ["@material-ui/icons/SubtitlesRounded" :default SubtitlesRounded]
            ["@material-ui/icons/SubtitlesSharp" :default SubtitlesSharp]
            ["@material-ui/icons/SubtitlesTwoTone" :default SubtitlesTwoTone]
            ["@material-ui/icons/Subway" :default Subway]
            ["@material-ui/icons/SubwayOutlined" :default SubwayOutlined]
            ["@material-ui/icons/SubwayRounded" :default SubwayRounded]
            ["@material-ui/icons/SubwaySharp" :default SubwaySharp]
            ["@material-ui/icons/SubwayTwoTone" :default SubwayTwoTone]
            ["@material-ui/icons/SupervisedUserCircle" :default SupervisedUserCircle]
            ["@material-ui/icons/SupervisedUserCircleOutlined" :default SupervisedUserCircleOutlined]
            ["@material-ui/icons/SupervisedUserCircleRounded" :default SupervisedUserCircleRounded]
            ["@material-ui/icons/SupervisedUserCircleSharp" :default SupervisedUserCircleSharp]
            ["@material-ui/icons/SupervisedUserCircleTwoTone" :default SupervisedUserCircleTwoTone]
            ["@material-ui/icons/SupervisorAccount" :default SupervisorAccount]
            ["@material-ui/icons/SupervisorAccountOutlined" :default SupervisorAccountOutlined]
            ["@material-ui/icons/SupervisorAccountRounded" :default SupervisorAccountRounded]
            ["@material-ui/icons/SupervisorAccountSharp" :default SupervisorAccountSharp]
            ["@material-ui/icons/SupervisorAccountTwoTone" :default SupervisorAccountTwoTone]
            ["@material-ui/icons/SurroundSound" :default SurroundSound]
            ["@material-ui/icons/SurroundSoundOutlined" :default SurroundSoundOutlined]
            ["@material-ui/icons/SurroundSoundRounded" :default SurroundSoundRounded]
            ["@material-ui/icons/SurroundSoundSharp" :default SurroundSoundSharp]
            ["@material-ui/icons/SurroundSoundTwoTone" :default SurroundSoundTwoTone]
            ["@material-ui/icons/SwapCalls" :default SwapCalls]
            ["@material-ui/icons/SwapCallsOutlined" :default SwapCallsOutlined]
            ["@material-ui/icons/SwapCallsRounded" :default SwapCallsRounded]
            ["@material-ui/icons/SwapCallsSharp" :default SwapCallsSharp]
            ["@material-ui/icons/SwapCallsTwoTone" :default SwapCallsTwoTone]
            ["@material-ui/icons/SwapHoriz" :default SwapHoriz]
            ["@material-ui/icons/SwapHorizontalCircle" :default SwapHorizontalCircle]
            ["@material-ui/icons/SwapHorizontalCircleOutlined" :default SwapHorizontalCircleOutlined]
            ["@material-ui/icons/SwapHorizontalCircleRounded" :default SwapHorizontalCircleRounded]
            ["@material-ui/icons/SwapHorizontalCircleSharp" :default SwapHorizontalCircleSharp]
            ["@material-ui/icons/SwapHorizontalCircleTwoTone" :default SwapHorizontalCircleTwoTone]
            ["@material-ui/icons/SwapHorizOutlined" :default SwapHorizOutlined]
            ["@material-ui/icons/SwapHorizRounded" :default SwapHorizRounded]
            ["@material-ui/icons/SwapHorizSharp" :default SwapHorizSharp]
            ["@material-ui/icons/SwapHorizTwoTone" :default SwapHorizTwoTone]
            ["@material-ui/icons/SwapVert" :default SwapVert]
            ["@material-ui/icons/SwapVerticalCircle" :default SwapVerticalCircle]
            ["@material-ui/icons/SwapVerticalCircleOutlined" :default SwapVerticalCircleOutlined]
            ["@material-ui/icons/SwapVerticalCircleRounded" :default SwapVerticalCircleRounded]
            ["@material-ui/icons/SwapVerticalCircleSharp" :default SwapVerticalCircleSharp]
            ["@material-ui/icons/SwapVerticalCircleTwoTone" :default SwapVerticalCircleTwoTone]
            ["@material-ui/icons/SwapVertOutlined" :default SwapVertOutlined]
            ["@material-ui/icons/SwapVertRounded" :default SwapVertRounded]
            ["@material-ui/icons/SwapVertSharp" :default SwapVertSharp]
            ["@material-ui/icons/SwapVertTwoTone" :default SwapVertTwoTone]
            ["@material-ui/icons/SwitchCamera" :default SwitchCamera]
            ["@material-ui/icons/SwitchCameraOutlined" :default SwitchCameraOutlined]
            ["@material-ui/icons/SwitchCameraRounded" :default SwitchCameraRounded]
            ["@material-ui/icons/SwitchCameraSharp" :default SwitchCameraSharp]
            ["@material-ui/icons/SwitchCameraTwoTone" :default SwitchCameraTwoTone]
            ["@material-ui/icons/SwitchVideo" :default SwitchVideo]
            ["@material-ui/icons/SwitchVideoOutlined" :default SwitchVideoOutlined]
            ["@material-ui/icons/SwitchVideoRounded" :default SwitchVideoRounded]
            ["@material-ui/icons/SwitchVideoSharp" :default SwitchVideoSharp]
            ["@material-ui/icons/SwitchVideoTwoTone" :default SwitchVideoTwoTone]
            ["@material-ui/icons/Sync" :default Sync]
            ["@material-ui/icons/SyncAlt" :default SyncAlt]
            ["@material-ui/icons/SyncAltOutlined" :default SyncAltOutlined]
            ["@material-ui/icons/SyncAltRounded" :default SyncAltRounded]
            ["@material-ui/icons/SyncAltSharp" :default SyncAltSharp]
            ["@material-ui/icons/SyncAltTwoTone" :default SyncAltTwoTone]
            ["@material-ui/icons/SyncDisabled" :default SyncDisabled]
            ["@material-ui/icons/SyncDisabledOutlined" :default SyncDisabledOutlined]
            ["@material-ui/icons/SyncDisabledRounded" :default SyncDisabledRounded]
            ["@material-ui/icons/SyncDisabledSharp" :default SyncDisabledSharp]
            ["@material-ui/icons/SyncDisabledTwoTone" :default SyncDisabledTwoTone]
            ["@material-ui/icons/SyncOutlined" :default SyncOutlined]
            ["@material-ui/icons/SyncProblem" :default SyncProblem]
            ["@material-ui/icons/SyncProblemOutlined" :default SyncProblemOutlined]
            ["@material-ui/icons/SyncProblemRounded" :default SyncProblemRounded]
            ["@material-ui/icons/SyncProblemSharp" :default SyncProblemSharp]
            ["@material-ui/icons/SyncProblemTwoTone" :default SyncProblemTwoTone]
            ["@material-ui/icons/SyncRounded" :default SyncRounded]
            ["@material-ui/icons/SyncSharp" :default SyncSharp]
            ["@material-ui/icons/SyncTwoTone" :default SyncTwoTone]
            ["@material-ui/icons/SystemUpdate" :default SystemUpdate]
            ["@material-ui/icons/SystemUpdateAlt" :default SystemUpdateAlt]
            ["@material-ui/icons/SystemUpdateAltOutlined" :default SystemUpdateAltOutlined]
            ["@material-ui/icons/SystemUpdateAltRounded" :default SystemUpdateAltRounded]
            ["@material-ui/icons/SystemUpdateAltSharp" :default SystemUpdateAltSharp]
            ["@material-ui/icons/SystemUpdateAltTwoTone" :default SystemUpdateAltTwoTone]
            ["@material-ui/icons/SystemUpdateOutlined" :default SystemUpdateOutlined]
            ["@material-ui/icons/SystemUpdateRounded" :default SystemUpdateRounded]
            ["@material-ui/icons/SystemUpdateSharp" :default SystemUpdateSharp]
            ["@material-ui/icons/SystemUpdateTwoTone" :default SystemUpdateTwoTone]
            ["@material-ui/icons/Tab" :default Tab]
            ["@material-ui/icons/TableChart" :default TableChart]
            ["@material-ui/icons/TableChartOutlined" :default TableChartOutlined]
            ["@material-ui/icons/TableChartRounded" :default TableChartRounded]
            ["@material-ui/icons/TableChartSharp" :default TableChartSharp]
            ["@material-ui/icons/TableChartTwoTone" :default TableChartTwoTone]
            ["@material-ui/icons/Tablet" :default Tablet]
            ["@material-ui/icons/TabletAndroid" :default TabletAndroid]
            ["@material-ui/icons/TabletAndroidOutlined" :default TabletAndroidOutlined]
            ["@material-ui/icons/TabletAndroidRounded" :default TabletAndroidRounded]
            ["@material-ui/icons/TabletAndroidSharp" :default TabletAndroidSharp]
            ["@material-ui/icons/TabletAndroidTwoTone" :default TabletAndroidTwoTone]
            ["@material-ui/icons/TabletMac" :default TabletMac]
            ["@material-ui/icons/TabletMacOutlined" :default TabletMacOutlined]
            ["@material-ui/icons/TabletMacRounded" :default TabletMacRounded]
            ["@material-ui/icons/TabletMacSharp" :default TabletMacSharp]
            ["@material-ui/icons/TabletMacTwoTone" :default TabletMacTwoTone]
            ["@material-ui/icons/TabletOutlined" :default TabletOutlined]
            ["@material-ui/icons/TabletRounded" :default TabletRounded]
            ["@material-ui/icons/TabletSharp" :default TabletSharp]
            ["@material-ui/icons/TabletTwoTone" :default TabletTwoTone]
            ["@material-ui/icons/TabOutlined" :default TabOutlined]
            ["@material-ui/icons/TabRounded" :default TabRounded]
            ["@material-ui/icons/TabSharp" :default TabSharp]
            ["@material-ui/icons/TabTwoTone" :default TabTwoTone]
            ["@material-ui/icons/TabUnselected" :default TabUnselected]
            ["@material-ui/icons/TabUnselectedOutlined" :default TabUnselectedOutlined]
            ["@material-ui/icons/TabUnselectedRounded" :default TabUnselectedRounded]
            ["@material-ui/icons/TabUnselectedSharp" :default TabUnselectedSharp]
            ["@material-ui/icons/TabUnselectedTwoTone" :default TabUnselectedTwoTone]
            ["@material-ui/icons/TagFaces" :default TagFaces]
            ["@material-ui/icons/TagFacesOutlined" :default TagFacesOutlined]
            ["@material-ui/icons/TagFacesRounded" :default TagFacesRounded]
            ["@material-ui/icons/TagFacesSharp" :default TagFacesSharp]
            ["@material-ui/icons/TagFacesTwoTone" :default TagFacesTwoTone]
            ["@material-ui/icons/TapAndPlay" :default TapAndPlay]
            ["@material-ui/icons/TapAndPlayOutlined" :default TapAndPlayOutlined]
            ["@material-ui/icons/TapAndPlayRounded" :default TapAndPlayRounded]
            ["@material-ui/icons/TapAndPlaySharp" :default TapAndPlaySharp]
            ["@material-ui/icons/TapAndPlayTwoTone" :default TapAndPlayTwoTone]
            ["@material-ui/icons/Telegram" :default Telegram]
            ["@material-ui/icons/Terrain" :default Terrain]
            ["@material-ui/icons/TerrainOutlined" :default TerrainOutlined]
            ["@material-ui/icons/TerrainRounded" :default TerrainRounded]
            ["@material-ui/icons/TerrainSharp" :default TerrainSharp]
            ["@material-ui/icons/TerrainTwoTone" :default TerrainTwoTone]
            ["@material-ui/icons/TextFields" :default TextFields]
            ["@material-ui/icons/TextFieldsOutlined" :default TextFieldsOutlined]
            ["@material-ui/icons/TextFieldsRounded" :default TextFieldsRounded]
            ["@material-ui/icons/TextFieldsSharp" :default TextFieldsSharp]
            ["@material-ui/icons/TextFieldsTwoTone" :default TextFieldsTwoTone]
            ["@material-ui/icons/TextFormat" :default TextFormat]
            ["@material-ui/icons/TextFormatOutlined" :default TextFormatOutlined]
            ["@material-ui/icons/TextFormatRounded" :default TextFormatRounded]
            ["@material-ui/icons/TextFormatSharp" :default TextFormatSharp]
            ["@material-ui/icons/TextFormatTwoTone" :default TextFormatTwoTone]
            ["@material-ui/icons/TextRotateUp" :default TextRotateUp]
            ["@material-ui/icons/TextRotateUpOutlined" :default TextRotateUpOutlined]
            ["@material-ui/icons/TextRotateUpRounded" :default TextRotateUpRounded]
            ["@material-ui/icons/TextRotateUpSharp" :default TextRotateUpSharp]
            ["@material-ui/icons/TextRotateUpTwoTone" :default TextRotateUpTwoTone]
            ["@material-ui/icons/TextRotateVertical" :default TextRotateVertical]
            ["@material-ui/icons/TextRotateVerticalOutlined" :default TextRotateVerticalOutlined]
            ["@material-ui/icons/TextRotateVerticalRounded" :default TextRotateVerticalRounded]
            ["@material-ui/icons/TextRotateVerticalSharp" :default TextRotateVerticalSharp]
            ["@material-ui/icons/TextRotateVerticalTwoTone" :default TextRotateVerticalTwoTone]
            ["@material-ui/icons/TextRotationAngledown" :default TextRotationAngledown]
            ["@material-ui/icons/TextRotationAngledownOutlined" :default TextRotationAngledownOutlined]
            ["@material-ui/icons/TextRotationAngledownRounded" :default TextRotationAngledownRounded]
            ["@material-ui/icons/TextRotationAngledownSharp" :default TextRotationAngledownSharp]
            ["@material-ui/icons/TextRotationAngledownTwoTone" :default TextRotationAngledownTwoTone]
            ["@material-ui/icons/TextRotationAngleup" :default TextRotationAngleup]
            ["@material-ui/icons/TextRotationAngleupOutlined" :default TextRotationAngleupOutlined]
            ["@material-ui/icons/TextRotationAngleupRounded" :default TextRotationAngleupRounded]
            ["@material-ui/icons/TextRotationAngleupSharp" :default TextRotationAngleupSharp]
            ["@material-ui/icons/TextRotationAngleupTwoTone" :default TextRotationAngleupTwoTone]
            ["@material-ui/icons/TextRotationDown" :default TextRotationDown]
            ["@material-ui/icons/TextRotationDownOutlined" :default TextRotationDownOutlined]
            ["@material-ui/icons/TextRotationDownRounded" :default TextRotationDownRounded]
            ["@material-ui/icons/TextRotationDownSharp" :default TextRotationDownSharp]
            ["@material-ui/icons/TextRotationDownTwoTone" :default TextRotationDownTwoTone]
            ["@material-ui/icons/TextRotationNone" :default TextRotationNone]
            ["@material-ui/icons/TextRotationNoneOutlined" :default TextRotationNoneOutlined]
            ["@material-ui/icons/TextRotationNoneRounded" :default TextRotationNoneRounded]
            ["@material-ui/icons/TextRotationNoneSharp" :default TextRotationNoneSharp]
            ["@material-ui/icons/TextRotationNoneTwoTone" :default TextRotationNoneTwoTone]
            ["@material-ui/icons/Textsms" :default Textsms]
            ["@material-ui/icons/TextsmsOutlined" :default TextsmsOutlined]
            ["@material-ui/icons/TextsmsRounded" :default TextsmsRounded]
            ["@material-ui/icons/TextsmsSharp" :default TextsmsSharp]
            ["@material-ui/icons/TextsmsTwoTone" :default TextsmsTwoTone]
            ["@material-ui/icons/Texture" :default Texture]
            ["@material-ui/icons/TextureOutlined" :default TextureOutlined]
            ["@material-ui/icons/TextureRounded" :default TextureRounded]
            ["@material-ui/icons/TextureSharp" :default TextureSharp]
            ["@material-ui/icons/TextureTwoTone" :default TextureTwoTone]
            ["@material-ui/icons/Theaters" :default Theaters]
            ["@material-ui/icons/TheatersOutlined" :default TheatersOutlined]
            ["@material-ui/icons/TheatersRounded" :default TheatersRounded]
            ["@material-ui/icons/TheatersSharp" :default TheatersSharp]
            ["@material-ui/icons/TheatersTwoTone" :default TheatersTwoTone]
            ["@material-ui/icons/ThreeDRotation" :default ThreeDRotation]
            ["@material-ui/icons/ThreeDRotationOutlined" :default ThreeDRotationOutlined]
            ["@material-ui/icons/ThreeDRotationRounded" :default ThreeDRotationRounded]
            ["@material-ui/icons/ThreeDRotationSharp" :default ThreeDRotationSharp]
            ["@material-ui/icons/ThreeDRotationTwoTone" :default ThreeDRotationTwoTone]
            ["@material-ui/icons/ThreeSixty" :default ThreeSixty]
            ["@material-ui/icons/ThreeSixtyOutlined" :default ThreeSixtyOutlined]
            ["@material-ui/icons/ThreeSixtyRounded" :default ThreeSixtyRounded]
            ["@material-ui/icons/ThreeSixtySharp" :default ThreeSixtySharp]
            ["@material-ui/icons/ThreeSixtyTwoTone" :default ThreeSixtyTwoTone]
            ["@material-ui/icons/ThumbDown" :default ThumbDown]
            ["@material-ui/icons/ThumbDownAlt" :default ThumbDownAlt]
            ["@material-ui/icons/ThumbDownAltOutlined" :default ThumbDownAltOutlined]
            ["@material-ui/icons/ThumbDownAltRounded" :default ThumbDownAltRounded]
            ["@material-ui/icons/ThumbDownAltSharp" :default ThumbDownAltSharp]
            ["@material-ui/icons/ThumbDownAltTwoTone" :default ThumbDownAltTwoTone]
            ["@material-ui/icons/ThumbDownOutlined" :default ThumbDownOutlined]
            ["@material-ui/icons/ThumbDownRounded" :default ThumbDownRounded]
            ["@material-ui/icons/ThumbDownSharp" :default ThumbDownSharp]
            ["@material-ui/icons/ThumbDownTwoTone" :default ThumbDownTwoTone]
            ["@material-ui/icons/ThumbsUpDown" :default ThumbsUpDown]
            ["@material-ui/icons/ThumbsUpDownOutlined" :default ThumbsUpDownOutlined]
            ["@material-ui/icons/ThumbsUpDownRounded" :default ThumbsUpDownRounded]
            ["@material-ui/icons/ThumbsUpDownSharp" :default ThumbsUpDownSharp]
            ["@material-ui/icons/ThumbsUpDownTwoTone" :default ThumbsUpDownTwoTone]
            ["@material-ui/icons/ThumbUp" :default ThumbUp]
            ["@material-ui/icons/ThumbUpAlt" :default ThumbUpAlt]
            ["@material-ui/icons/ThumbUpAltOutlined" :default ThumbUpAltOutlined]
            ["@material-ui/icons/ThumbUpAltRounded" :default ThumbUpAltRounded]
            ["@material-ui/icons/ThumbUpAltSharp" :default ThumbUpAltSharp]
            ["@material-ui/icons/ThumbUpAltTwoTone" :default ThumbUpAltTwoTone]
            ["@material-ui/icons/ThumbUpOutlined" :default ThumbUpOutlined]
            ["@material-ui/icons/ThumbUpRounded" :default ThumbUpRounded]
            ["@material-ui/icons/ThumbUpSharp" :default ThumbUpSharp]
            ["@material-ui/icons/ThumbUpTwoTone" :default ThumbUpTwoTone]
            ["@material-ui/icons/Timelapse" :default Timelapse]
            ["@material-ui/icons/TimelapseOutlined" :default TimelapseOutlined]
            ["@material-ui/icons/TimelapseRounded" :default TimelapseRounded]
            ["@material-ui/icons/TimelapseSharp" :default TimelapseSharp]
            ["@material-ui/icons/TimelapseTwoTone" :default TimelapseTwoTone]
            ["@material-ui/icons/Timeline" :default Timeline]
            ["@material-ui/icons/TimelineOutlined" :default TimelineOutlined]
            ["@material-ui/icons/TimelineRounded" :default TimelineRounded]
            ["@material-ui/icons/TimelineSharp" :default TimelineSharp]
            ["@material-ui/icons/TimelineTwoTone" :default TimelineTwoTone]
            ["@material-ui/icons/Timer" :default Timer]
            ["@material-ui/icons/Timer10" :default Timer10]
            ["@material-ui/icons/Timer10Outlined" :default Timer10Outlined]
            ["@material-ui/icons/Timer10Rounded" :default Timer10Rounded]
            ["@material-ui/icons/Timer10Sharp" :default Timer10Sharp]
            ["@material-ui/icons/Timer10TwoTone" :default Timer10TwoTone]
            ["@material-ui/icons/Timer3" :default Timer3]
            ["@material-ui/icons/Timer3Outlined" :default Timer3Outlined]
            ["@material-ui/icons/Timer3Rounded" :default Timer3Rounded]
            ["@material-ui/icons/Timer3Sharp" :default Timer3Sharp]
            ["@material-ui/icons/Timer3TwoTone" :default Timer3TwoTone]
            ["@material-ui/icons/TimerOff" :default TimerOff]
            ["@material-ui/icons/TimerOffOutlined" :default TimerOffOutlined]
            ["@material-ui/icons/TimerOffRounded" :default TimerOffRounded]
            ["@material-ui/icons/TimerOffSharp" :default TimerOffSharp]
            ["@material-ui/icons/TimerOffTwoTone" :default TimerOffTwoTone]
            ["@material-ui/icons/TimerOutlined" :default TimerOutlined]
            ["@material-ui/icons/TimerRounded" :default TimerRounded]
            ["@material-ui/icons/TimerSharp" :default TimerSharp]
            ["@material-ui/icons/TimerTwoTone" :default TimerTwoTone]
            ["@material-ui/icons/TimeToLeave" :default TimeToLeave]
            ["@material-ui/icons/TimeToLeaveOutlined" :default TimeToLeaveOutlined]
            ["@material-ui/icons/TimeToLeaveRounded" :default TimeToLeaveRounded]
            ["@material-ui/icons/TimeToLeaveSharp" :default TimeToLeaveSharp]
            ["@material-ui/icons/TimeToLeaveTwoTone" :default TimeToLeaveTwoTone]
            ["@material-ui/icons/Title" :default Title]
            ["@material-ui/icons/TitleOutlined" :default TitleOutlined]
            ["@material-ui/icons/TitleRounded" :default TitleRounded]
            ["@material-ui/icons/TitleSharp" :default TitleSharp]
            ["@material-ui/icons/TitleTwoTone" :default TitleTwoTone]
            ["@material-ui/icons/Toc" :default Toc]
            ["@material-ui/icons/TocOutlined" :default TocOutlined]
            ["@material-ui/icons/TocRounded" :default TocRounded]
            ["@material-ui/icons/TocSharp" :default TocSharp]
            ["@material-ui/icons/TocTwoTone" :default TocTwoTone]
            ["@material-ui/icons/Today" :default Today]
            ["@material-ui/icons/TodayOutlined" :default TodayOutlined]
            ["@material-ui/icons/TodayRounded" :default TodayRounded]
            ["@material-ui/icons/TodaySharp" :default TodaySharp]
            ["@material-ui/icons/TodayTwoTone" :default TodayTwoTone]
            ["@material-ui/icons/ToggleOff" :default ToggleOff]
            ["@material-ui/icons/ToggleOffOutlined" :default ToggleOffOutlined]
            ["@material-ui/icons/ToggleOffRounded" :default ToggleOffRounded]
            ["@material-ui/icons/ToggleOffSharp" :default ToggleOffSharp]
            ["@material-ui/icons/ToggleOffTwoTone" :default ToggleOffTwoTone]
            ["@material-ui/icons/ToggleOn" :default ToggleOn]
            ["@material-ui/icons/ToggleOnOutlined" :default ToggleOnOutlined]
            ["@material-ui/icons/ToggleOnRounded" :default ToggleOnRounded]
            ["@material-ui/icons/ToggleOnSharp" :default ToggleOnSharp]
            ["@material-ui/icons/ToggleOnTwoTone" :default ToggleOnTwoTone]
            ["@material-ui/icons/Toll" :default Toll]
            ["@material-ui/icons/TollOutlined" :default TollOutlined]
            ["@material-ui/icons/TollRounded" :default TollRounded]
            ["@material-ui/icons/TollSharp" :default TollSharp]
            ["@material-ui/icons/TollTwoTone" :default TollTwoTone]
            ["@material-ui/icons/Tonality" :default Tonality]
            ["@material-ui/icons/TonalityOutlined" :default TonalityOutlined]
            ["@material-ui/icons/TonalityRounded" :default TonalityRounded]
            ["@material-ui/icons/TonalitySharp" :default TonalitySharp]
            ["@material-ui/icons/TonalityTwoTone" :default TonalityTwoTone]
            ["@material-ui/icons/TouchApp" :default TouchApp]
            ["@material-ui/icons/TouchAppOutlined" :default TouchAppOutlined]
            ["@material-ui/icons/TouchAppRounded" :default TouchAppRounded]
            ["@material-ui/icons/TouchAppSharp" :default TouchAppSharp]
            ["@material-ui/icons/TouchAppTwoTone" :default TouchAppTwoTone]
            ["@material-ui/icons/Toys" :default Toys]
            ["@material-ui/icons/ToysOutlined" :default ToysOutlined]
            ["@material-ui/icons/ToysRounded" :default ToysRounded]
            ["@material-ui/icons/ToysSharp" :default ToysSharp]
            ["@material-ui/icons/ToysTwoTone" :default ToysTwoTone]
            ["@material-ui/icons/TrackChanges" :default TrackChanges]
            ["@material-ui/icons/TrackChangesOutlined" :default TrackChangesOutlined]
            ["@material-ui/icons/TrackChangesRounded" :default TrackChangesRounded]
            ["@material-ui/icons/TrackChangesSharp" :default TrackChangesSharp]
            ["@material-ui/icons/TrackChangesTwoTone" :default TrackChangesTwoTone]
            ["@material-ui/icons/Traffic" :default Traffic]
            ["@material-ui/icons/TrafficOutlined" :default TrafficOutlined]
            ["@material-ui/icons/TrafficRounded" :default TrafficRounded]
            ["@material-ui/icons/TrafficSharp" :default TrafficSharp]
            ["@material-ui/icons/TrafficTwoTone" :default TrafficTwoTone]
            ["@material-ui/icons/Train" :default Train]
            ["@material-ui/icons/TrainOutlined" :default TrainOutlined]
            ["@material-ui/icons/TrainRounded" :default TrainRounded]
            ["@material-ui/icons/TrainSharp" :default TrainSharp]
            ["@material-ui/icons/TrainTwoTone" :default TrainTwoTone]
            ["@material-ui/icons/Tram" :default Tram]
            ["@material-ui/icons/TramOutlined" :default TramOutlined]
            ["@material-ui/icons/TramRounded" :default TramRounded]
            ["@material-ui/icons/TramSharp" :default TramSharp]
            ["@material-ui/icons/TramTwoTone" :default TramTwoTone]
            ["@material-ui/icons/TransferWithinAStation" :default TransferWithinAStation]
            ["@material-ui/icons/TransferWithinAStationOutlined" :default TransferWithinAStationOutlined]
            ["@material-ui/icons/TransferWithinAStationRounded" :default TransferWithinAStationRounded]
            ["@material-ui/icons/TransferWithinAStationSharp" :default TransferWithinAStationSharp]
            ["@material-ui/icons/TransferWithinAStationTwoTone" :default TransferWithinAStationTwoTone]
            ["@material-ui/icons/Transform" :default Transform]
            ["@material-ui/icons/TransformOutlined" :default TransformOutlined]
            ["@material-ui/icons/TransformRounded" :default TransformRounded]
            ["@material-ui/icons/TransformSharp" :default TransformSharp]
            ["@material-ui/icons/TransformTwoTone" :default TransformTwoTone]
            ["@material-ui/icons/TransitEnterexit" :default TransitEnterexit]
            ["@material-ui/icons/TransitEnterexitOutlined" :default TransitEnterexitOutlined]
            ["@material-ui/icons/TransitEnterexitRounded" :default TransitEnterexitRounded]
            ["@material-ui/icons/TransitEnterexitSharp" :default TransitEnterexitSharp]
            ["@material-ui/icons/TransitEnterexitTwoTone" :default TransitEnterexitTwoTone]
            ["@material-ui/icons/Translate" :default Translate]
            ["@material-ui/icons/TranslateOutlined" :default TranslateOutlined]
            ["@material-ui/icons/TranslateRounded" :default TranslateRounded]
            ["@material-ui/icons/TranslateSharp" :default TranslateSharp]
            ["@material-ui/icons/TranslateTwoTone" :default TranslateTwoTone]
            ["@material-ui/icons/TrendingDown" :default TrendingDown]
            ["@material-ui/icons/TrendingDownOutlined" :default TrendingDownOutlined]
            ["@material-ui/icons/TrendingDownRounded" :default TrendingDownRounded]
            ["@material-ui/icons/TrendingDownSharp" :default TrendingDownSharp]
            ["@material-ui/icons/TrendingDownTwoTone" :default TrendingDownTwoTone]
            ["@material-ui/icons/TrendingFlat" :default TrendingFlat]
            ["@material-ui/icons/TrendingFlatOutlined" :default TrendingFlatOutlined]
            ["@material-ui/icons/TrendingFlatRounded" :default TrendingFlatRounded]
            ["@material-ui/icons/TrendingFlatSharp" :default TrendingFlatSharp]
            ["@material-ui/icons/TrendingFlatTwoTone" :default TrendingFlatTwoTone]
            ["@material-ui/icons/TrendingUp" :default TrendingUp]
            ["@material-ui/icons/TrendingUpOutlined" :default TrendingUpOutlined]
            ["@material-ui/icons/TrendingUpRounded" :default TrendingUpRounded]
            ["@material-ui/icons/TrendingUpSharp" :default TrendingUpSharp]
            ["@material-ui/icons/TrendingUpTwoTone" :default TrendingUpTwoTone]
            ["@material-ui/icons/TripOrigin" :default TripOrigin]
            ["@material-ui/icons/TripOriginOutlined" :default TripOriginOutlined]
            ["@material-ui/icons/TripOriginRounded" :default TripOriginRounded]
            ["@material-ui/icons/TripOriginSharp" :default TripOriginSharp]
            ["@material-ui/icons/TripOriginTwoTone" :default TripOriginTwoTone]
            ["@material-ui/icons/Tune" :default Tune]
            ["@material-ui/icons/TuneOutlined" :default TuneOutlined]
            ["@material-ui/icons/TuneRounded" :default TuneRounded]
            ["@material-ui/icons/TuneSharp" :default TuneSharp]
            ["@material-ui/icons/TuneTwoTone" :default TuneTwoTone]
            ["@material-ui/icons/TurnedIn" :default TurnedIn]
            ["@material-ui/icons/TurnedInNot" :default TurnedInNot]
            ["@material-ui/icons/TurnedInNotOutlined" :default TurnedInNotOutlined]
            ["@material-ui/icons/TurnedInNotRounded" :default TurnedInNotRounded]
            ["@material-ui/icons/TurnedInNotSharp" :default TurnedInNotSharp]
            ["@material-ui/icons/TurnedInNotTwoTone" :default TurnedInNotTwoTone]
            ["@material-ui/icons/TurnedInOutlined" :default TurnedInOutlined]
            ["@material-ui/icons/TurnedInRounded" :default TurnedInRounded]
            ["@material-ui/icons/TurnedInSharp" :default TurnedInSharp]
            ["@material-ui/icons/TurnedInTwoTone" :default TurnedInTwoTone]
            ["@material-ui/icons/Tv" :default Tv]
            ["@material-ui/icons/TvOff" :default TvOff]
            ["@material-ui/icons/TvOffOutlined" :default TvOffOutlined]
            ["@material-ui/icons/TvOffRounded" :default TvOffRounded]
            ["@material-ui/icons/TvOffSharp" :default TvOffSharp]
            ["@material-ui/icons/TvOffTwoTone" :default TvOffTwoTone]
            ["@material-ui/icons/TvOutlined" :default TvOutlined]
            ["@material-ui/icons/TvRounded" :default TvRounded]
            ["@material-ui/icons/TvSharp" :default TvSharp]
            ["@material-ui/icons/TvTwoTone" :default TvTwoTone]
            ["@material-ui/icons/Twitter" :default Twitter]
            ["@material-ui/icons/Unarchive" :default Unarchive]
            ["@material-ui/icons/UnarchiveOutlined" :default UnarchiveOutlined]
            ["@material-ui/icons/UnarchiveRounded" :default UnarchiveRounded]
            ["@material-ui/icons/UnarchiveSharp" :default UnarchiveSharp]
            ["@material-ui/icons/UnarchiveTwoTone" :default UnarchiveTwoTone]
            ["@material-ui/icons/Undo" :default Undo]
            ["@material-ui/icons/UndoOutlined" :default UndoOutlined]
            ["@material-ui/icons/UndoRounded" :default UndoRounded]
            ["@material-ui/icons/UndoSharp" :default UndoSharp]
            ["@material-ui/icons/UndoTwoTone" :default UndoTwoTone]
            ["@material-ui/icons/UnfoldLess" :default UnfoldLess]
            ["@material-ui/icons/UnfoldLessOutlined" :default UnfoldLessOutlined]
            ["@material-ui/icons/UnfoldLessRounded" :default UnfoldLessRounded]
            ["@material-ui/icons/UnfoldLessSharp" :default UnfoldLessSharp]
            ["@material-ui/icons/UnfoldLessTwoTone" :default UnfoldLessTwoTone]
            ["@material-ui/icons/UnfoldMore" :default UnfoldMore]
            ["@material-ui/icons/UnfoldMoreOutlined" :default UnfoldMoreOutlined]
            ["@material-ui/icons/UnfoldMoreRounded" :default UnfoldMoreRounded]
            ["@material-ui/icons/UnfoldMoreSharp" :default UnfoldMoreSharp]
            ["@material-ui/icons/UnfoldMoreTwoTone" :default UnfoldMoreTwoTone]
            ["@material-ui/icons/Unsubscribe" :default Unsubscribe]
            ["@material-ui/icons/UnsubscribeOutlined" :default UnsubscribeOutlined]
            ["@material-ui/icons/UnsubscribeRounded" :default UnsubscribeRounded]
            ["@material-ui/icons/UnsubscribeSharp" :default UnsubscribeSharp]
            ["@material-ui/icons/UnsubscribeTwoTone" :default UnsubscribeTwoTone]
            ["@material-ui/icons/Update" :default Update]
            ["@material-ui/icons/UpdateOutlined" :default UpdateOutlined]
            ["@material-ui/icons/UpdateRounded" :default UpdateRounded]
            ["@material-ui/icons/UpdateSharp" :default UpdateSharp]
            ["@material-ui/icons/UpdateTwoTone" :default UpdateTwoTone]
            ["@material-ui/icons/Usb" :default Usb]
            ["@material-ui/icons/UsbOutlined" :default UsbOutlined]
            ["@material-ui/icons/UsbRounded" :default UsbRounded]
            ["@material-ui/icons/UsbSharp" :default UsbSharp]
            ["@material-ui/icons/UsbTwoTone" :default UsbTwoTone]
            ["@material-ui/icons/VerifiedUser" :default VerifiedUser]
            ["@material-ui/icons/VerifiedUserOutlined" :default VerifiedUserOutlined]
            ["@material-ui/icons/VerifiedUserRounded" :default VerifiedUserRounded]
            ["@material-ui/icons/VerifiedUserSharp" :default VerifiedUserSharp]
            ["@material-ui/icons/VerifiedUserTwoTone" :default VerifiedUserTwoTone]
            ["@material-ui/icons/VerticalAlignBottom" :default VerticalAlignBottom]
            ["@material-ui/icons/VerticalAlignBottomOutlined" :default VerticalAlignBottomOutlined]
            ["@material-ui/icons/VerticalAlignBottomRounded" :default VerticalAlignBottomRounded]
            ["@material-ui/icons/VerticalAlignBottomSharp" :default VerticalAlignBottomSharp]
            ["@material-ui/icons/VerticalAlignBottomTwoTone" :default VerticalAlignBottomTwoTone]
            ["@material-ui/icons/VerticalAlignCenter" :default VerticalAlignCenter]
            ["@material-ui/icons/VerticalAlignCenterOutlined" :default VerticalAlignCenterOutlined]
            ["@material-ui/icons/VerticalAlignCenterRounded" :default VerticalAlignCenterRounded]
            ["@material-ui/icons/VerticalAlignCenterSharp" :default VerticalAlignCenterSharp]
            ["@material-ui/icons/VerticalAlignCenterTwoTone" :default VerticalAlignCenterTwoTone]
            ["@material-ui/icons/VerticalAlignTop" :default VerticalAlignTop]
            ["@material-ui/icons/VerticalAlignTopOutlined" :default VerticalAlignTopOutlined]
            ["@material-ui/icons/VerticalAlignTopRounded" :default VerticalAlignTopRounded]
            ["@material-ui/icons/VerticalAlignTopSharp" :default VerticalAlignTopSharp]
            ["@material-ui/icons/VerticalAlignTopTwoTone" :default VerticalAlignTopTwoTone]
            ["@material-ui/icons/VerticalSplit" :default VerticalSplit]
            ["@material-ui/icons/VerticalSplitOutlined" :default VerticalSplitOutlined]
            ["@material-ui/icons/VerticalSplitRounded" :default VerticalSplitRounded]
            ["@material-ui/icons/VerticalSplitSharp" :default VerticalSplitSharp]
            ["@material-ui/icons/VerticalSplitTwoTone" :default VerticalSplitTwoTone]
            ["@material-ui/icons/Vibration" :default Vibration]
            ["@material-ui/icons/VibrationOutlined" :default VibrationOutlined]
            ["@material-ui/icons/VibrationRounded" :default VibrationRounded]
            ["@material-ui/icons/VibrationSharp" :default VibrationSharp]
            ["@material-ui/icons/VibrationTwoTone" :default VibrationTwoTone]
            ["@material-ui/icons/VideoCall" :default VideoCall]
            ["@material-ui/icons/VideoCallOutlined" :default VideoCallOutlined]
            ["@material-ui/icons/VideoCallRounded" :default VideoCallRounded]
            ["@material-ui/icons/VideoCallSharp" :default VideoCallSharp]
            ["@material-ui/icons/VideoCallTwoTone" :default VideoCallTwoTone]
            ["@material-ui/icons/Videocam" :default Videocam]
            ["@material-ui/icons/VideocamOff" :default VideocamOff]
            ["@material-ui/icons/VideocamOffOutlined" :default VideocamOffOutlined]
            ["@material-ui/icons/VideocamOffRounded" :default VideocamOffRounded]
            ["@material-ui/icons/VideocamOffSharp" :default VideocamOffSharp]
            ["@material-ui/icons/VideocamOffTwoTone" :default VideocamOffTwoTone]
            ["@material-ui/icons/VideocamOutlined" :default VideocamOutlined]
            ["@material-ui/icons/VideocamRounded" :default VideocamRounded]
            ["@material-ui/icons/VideocamSharp" :default VideocamSharp]
            ["@material-ui/icons/VideocamTwoTone" :default VideocamTwoTone]
            ["@material-ui/icons/VideogameAsset" :default VideogameAsset]
            ["@material-ui/icons/VideogameAssetOutlined" :default VideogameAssetOutlined]
            ["@material-ui/icons/VideogameAssetRounded" :default VideogameAssetRounded]
            ["@material-ui/icons/VideogameAssetSharp" :default VideogameAssetSharp]
            ["@material-ui/icons/VideogameAssetTwoTone" :default VideogameAssetTwoTone]
            ["@material-ui/icons/VideoLabel" :default VideoLabel]
            ["@material-ui/icons/VideoLabelOutlined" :default VideoLabelOutlined]
            ["@material-ui/icons/VideoLabelRounded" :default VideoLabelRounded]
            ["@material-ui/icons/VideoLabelSharp" :default VideoLabelSharp]
            ["@material-ui/icons/VideoLabelTwoTone" :default VideoLabelTwoTone]
            ["@material-ui/icons/VideoLibrary" :default VideoLibrary]
            ["@material-ui/icons/VideoLibraryOutlined" :default VideoLibraryOutlined]
            ["@material-ui/icons/VideoLibraryRounded" :default VideoLibraryRounded]
            ["@material-ui/icons/VideoLibrarySharp" :default VideoLibrarySharp]
            ["@material-ui/icons/VideoLibraryTwoTone" :default VideoLibraryTwoTone]
            ["@material-ui/icons/ViewAgenda" :default ViewAgenda]
            ["@material-ui/icons/ViewAgendaOutlined" :default ViewAgendaOutlined]
            ["@material-ui/icons/ViewAgendaRounded" :default ViewAgendaRounded]
            ["@material-ui/icons/ViewAgendaSharp" :default ViewAgendaSharp]
            ["@material-ui/icons/ViewAgendaTwoTone" :default ViewAgendaTwoTone]
            ["@material-ui/icons/ViewArray" :default ViewArray]
            ["@material-ui/icons/ViewArrayOutlined" :default ViewArrayOutlined]
            ["@material-ui/icons/ViewArrayRounded" :default ViewArrayRounded]
            ["@material-ui/icons/ViewArraySharp" :default ViewArraySharp]
            ["@material-ui/icons/ViewArrayTwoTone" :default ViewArrayTwoTone]
            ["@material-ui/icons/ViewCarousel" :default ViewCarousel]
            ["@material-ui/icons/ViewCarouselOutlined" :default ViewCarouselOutlined]
            ["@material-ui/icons/ViewCarouselRounded" :default ViewCarouselRounded]
            ["@material-ui/icons/ViewCarouselSharp" :default ViewCarouselSharp]
            ["@material-ui/icons/ViewCarouselTwoTone" :default ViewCarouselTwoTone]
            ["@material-ui/icons/ViewColumn" :default ViewColumn]
            ["@material-ui/icons/ViewColumnOutlined" :default ViewColumnOutlined]
            ["@material-ui/icons/ViewColumnRounded" :default ViewColumnRounded]
            ["@material-ui/icons/ViewColumnSharp" :default ViewColumnSharp]
            ["@material-ui/icons/ViewColumnTwoTone" :default ViewColumnTwoTone]
            ["@material-ui/icons/ViewComfy" :default ViewComfy]
            ["@material-ui/icons/ViewComfyOutlined" :default ViewComfyOutlined]
            ["@material-ui/icons/ViewComfyRounded" :default ViewComfyRounded]
            ["@material-ui/icons/ViewComfySharp" :default ViewComfySharp]
            ["@material-ui/icons/ViewComfyTwoTone" :default ViewComfyTwoTone]
            ["@material-ui/icons/ViewCompact" :default ViewCompact]
            ["@material-ui/icons/ViewCompactOutlined" :default ViewCompactOutlined]
            ["@material-ui/icons/ViewCompactRounded" :default ViewCompactRounded]
            ["@material-ui/icons/ViewCompactSharp" :default ViewCompactSharp]
            ["@material-ui/icons/ViewCompactTwoTone" :default ViewCompactTwoTone]
            ["@material-ui/icons/ViewDay" :default ViewDay]
            ["@material-ui/icons/ViewDayOutlined" :default ViewDayOutlined]
            ["@material-ui/icons/ViewDayRounded" :default ViewDayRounded]
            ["@material-ui/icons/ViewDaySharp" :default ViewDaySharp]
            ["@material-ui/icons/ViewDayTwoTone" :default ViewDayTwoTone]
            ["@material-ui/icons/ViewHeadline" :default ViewHeadline]
            ["@material-ui/icons/ViewHeadlineOutlined" :default ViewHeadlineOutlined]
            ["@material-ui/icons/ViewHeadlineRounded" :default ViewHeadlineRounded]
            ["@material-ui/icons/ViewHeadlineSharp" :default ViewHeadlineSharp]
            ["@material-ui/icons/ViewHeadlineTwoTone" :default ViewHeadlineTwoTone]
            ["@material-ui/icons/ViewList" :default ViewList]
            ["@material-ui/icons/ViewListOutlined" :default ViewListOutlined]
            ["@material-ui/icons/ViewListRounded" :default ViewListRounded]
            ["@material-ui/icons/ViewListSharp" :default ViewListSharp]
            ["@material-ui/icons/ViewListTwoTone" :default ViewListTwoTone]
            ["@material-ui/icons/ViewModule" :default ViewModule]
            ["@material-ui/icons/ViewModuleOutlined" :default ViewModuleOutlined]
            ["@material-ui/icons/ViewModuleRounded" :default ViewModuleRounded]
            ["@material-ui/icons/ViewModuleSharp" :default ViewModuleSharp]
            ["@material-ui/icons/ViewModuleTwoTone" :default ViewModuleTwoTone]
            ["@material-ui/icons/ViewQuilt" :default ViewQuilt]
            ["@material-ui/icons/ViewQuiltOutlined" :default ViewQuiltOutlined]
            ["@material-ui/icons/ViewQuiltRounded" :default ViewQuiltRounded]
            ["@material-ui/icons/ViewQuiltSharp" :default ViewQuiltSharp]
            ["@material-ui/icons/ViewQuiltTwoTone" :default ViewQuiltTwoTone]
            ["@material-ui/icons/ViewStream" :default ViewStream]
            ["@material-ui/icons/ViewStreamOutlined" :default ViewStreamOutlined]
            ["@material-ui/icons/ViewStreamRounded" :default ViewStreamRounded]
            ["@material-ui/icons/ViewStreamSharp" :default ViewStreamSharp]
            ["@material-ui/icons/ViewStreamTwoTone" :default ViewStreamTwoTone]
            ["@material-ui/icons/ViewWeek" :default ViewWeek]
            ["@material-ui/icons/ViewWeekOutlined" :default ViewWeekOutlined]
            ["@material-ui/icons/ViewWeekRounded" :default ViewWeekRounded]
            ["@material-ui/icons/ViewWeekSharp" :default ViewWeekSharp]
            ["@material-ui/icons/ViewWeekTwoTone" :default ViewWeekTwoTone]
            ["@material-ui/icons/Vignette" :default Vignette]
            ["@material-ui/icons/VignetteOutlined" :default VignetteOutlined]
            ["@material-ui/icons/VignetteRounded" :default VignetteRounded]
            ["@material-ui/icons/VignetteSharp" :default VignetteSharp]
            ["@material-ui/icons/VignetteTwoTone" :default VignetteTwoTone]
            ["@material-ui/icons/Visibility" :default Visibility]
            ["@material-ui/icons/VisibilityOff" :default VisibilityOff]
            ["@material-ui/icons/VisibilityOffOutlined" :default VisibilityOffOutlined]
            ["@material-ui/icons/VisibilityOffRounded" :default VisibilityOffRounded]
            ["@material-ui/icons/VisibilityOffSharp" :default VisibilityOffSharp]
            ["@material-ui/icons/VisibilityOffTwoTone" :default VisibilityOffTwoTone]
            ["@material-ui/icons/VisibilityOutlined" :default VisibilityOutlined]
            ["@material-ui/icons/VisibilityRounded" :default VisibilityRounded]
            ["@material-ui/icons/VisibilitySharp" :default VisibilitySharp]
            ["@material-ui/icons/VisibilityTwoTone" :default VisibilityTwoTone]
            ["@material-ui/icons/VoiceChat" :default VoiceChat]
            ["@material-ui/icons/VoiceChatOutlined" :default VoiceChatOutlined]
            ["@material-ui/icons/VoiceChatRounded" :default VoiceChatRounded]
            ["@material-ui/icons/VoiceChatSharp" :default VoiceChatSharp]
            ["@material-ui/icons/VoiceChatTwoTone" :default VoiceChatTwoTone]
            ["@material-ui/icons/Voicemail" :default Voicemail]
            ["@material-ui/icons/VoicemailOutlined" :default VoicemailOutlined]
            ["@material-ui/icons/VoicemailRounded" :default VoicemailRounded]
            ["@material-ui/icons/VoicemailSharp" :default VoicemailSharp]
            ["@material-ui/icons/VoicemailTwoTone" :default VoicemailTwoTone]
            ["@material-ui/icons/VoiceOverOff" :default VoiceOverOff]
            ["@material-ui/icons/VoiceOverOffOutlined" :default VoiceOverOffOutlined]
            ["@material-ui/icons/VoiceOverOffRounded" :default VoiceOverOffRounded]
            ["@material-ui/icons/VoiceOverOffSharp" :default VoiceOverOffSharp]
            ["@material-ui/icons/VoiceOverOffTwoTone" :default VoiceOverOffTwoTone]
            ["@material-ui/icons/VolumeDown" :default VolumeDown]
            ["@material-ui/icons/VolumeDownOutlined" :default VolumeDownOutlined]
            ["@material-ui/icons/VolumeDownRounded" :default VolumeDownRounded]
            ["@material-ui/icons/VolumeDownSharp" :default VolumeDownSharp]
            ["@material-ui/icons/VolumeDownTwoTone" :default VolumeDownTwoTone]
            ["@material-ui/icons/VolumeMute" :default VolumeMute]
            ["@material-ui/icons/VolumeMuteOutlined" :default VolumeMuteOutlined]
            ["@material-ui/icons/VolumeMuteRounded" :default VolumeMuteRounded]
            ["@material-ui/icons/VolumeMuteSharp" :default VolumeMuteSharp]
            ["@material-ui/icons/VolumeMuteTwoTone" :default VolumeMuteTwoTone]
            ["@material-ui/icons/VolumeOff" :default VolumeOff]
            ["@material-ui/icons/VolumeOffOutlined" :default VolumeOffOutlined]
            ["@material-ui/icons/VolumeOffRounded" :default VolumeOffRounded]
            ["@material-ui/icons/VolumeOffSharp" :default VolumeOffSharp]
            ["@material-ui/icons/VolumeOffTwoTone" :default VolumeOffTwoTone]
            ["@material-ui/icons/VolumeUp" :default VolumeUp]
            ["@material-ui/icons/VolumeUpOutlined" :default VolumeUpOutlined]
            ["@material-ui/icons/VolumeUpRounded" :default VolumeUpRounded]
            ["@material-ui/icons/VolumeUpSharp" :default VolumeUpSharp]
            ["@material-ui/icons/VolumeUpTwoTone" :default VolumeUpTwoTone]
            ["@material-ui/icons/VpnKey" :default VpnKey]
            ["@material-ui/icons/VpnKeyOutlined" :default VpnKeyOutlined]
            ["@material-ui/icons/VpnKeyRounded" :default VpnKeyRounded]
            ["@material-ui/icons/VpnKeySharp" :default VpnKeySharp]
            ["@material-ui/icons/VpnKeyTwoTone" :default VpnKeyTwoTone]
            ["@material-ui/icons/VpnLock" :default VpnLock]
            ["@material-ui/icons/VpnLockOutlined" :default VpnLockOutlined]
            ["@material-ui/icons/VpnLockRounded" :default VpnLockRounded]
            ["@material-ui/icons/VpnLockSharp" :default VpnLockSharp]
            ["@material-ui/icons/VpnLockTwoTone" :default VpnLockTwoTone]
            ["@material-ui/icons/Wallpaper" :default Wallpaper]
            ["@material-ui/icons/WallpaperOutlined" :default WallpaperOutlined]
            ["@material-ui/icons/WallpaperRounded" :default WallpaperRounded]
            ["@material-ui/icons/WallpaperSharp" :default WallpaperSharp]
            ["@material-ui/icons/WallpaperTwoTone" :default WallpaperTwoTone]
            ["@material-ui/icons/Warning" :default Warning]
            ["@material-ui/icons/WarningOutlined" :default WarningOutlined]
            ["@material-ui/icons/WarningRounded" :default WarningRounded]
            ["@material-ui/icons/WarningSharp" :default WarningSharp]
            ["@material-ui/icons/WarningTwoTone" :default WarningTwoTone]
            ["@material-ui/icons/Watch" :default Watch]
            ["@material-ui/icons/WatchLater" :default WatchLater]
            ["@material-ui/icons/WatchLaterOutlined" :default WatchLaterOutlined]
            ["@material-ui/icons/WatchLaterRounded" :default WatchLaterRounded]
            ["@material-ui/icons/WatchLaterSharp" :default WatchLaterSharp]
            ["@material-ui/icons/WatchLaterTwoTone" :default WatchLaterTwoTone]
            ["@material-ui/icons/WatchOutlined" :default WatchOutlined]
            ["@material-ui/icons/WatchRounded" :default WatchRounded]
            ["@material-ui/icons/WatchSharp" :default WatchSharp]
            ["@material-ui/icons/WatchTwoTone" :default WatchTwoTone]
            ["@material-ui/icons/Waves" :default Waves]
            ["@material-ui/icons/WavesOutlined" :default WavesOutlined]
            ["@material-ui/icons/WavesRounded" :default WavesRounded]
            ["@material-ui/icons/WavesSharp" :default WavesSharp]
            ["@material-ui/icons/WavesTwoTone" :default WavesTwoTone]
            ["@material-ui/icons/WbAuto" :default WbAuto]
            ["@material-ui/icons/WbAutoOutlined" :default WbAutoOutlined]
            ["@material-ui/icons/WbAutoRounded" :default WbAutoRounded]
            ["@material-ui/icons/WbAutoSharp" :default WbAutoSharp]
            ["@material-ui/icons/WbAutoTwoTone" :default WbAutoTwoTone]
            ["@material-ui/icons/WbCloudy" :default WbCloudy]
            ["@material-ui/icons/WbCloudyOutlined" :default WbCloudyOutlined]
            ["@material-ui/icons/WbCloudyRounded" :default WbCloudyRounded]
            ["@material-ui/icons/WbCloudySharp" :default WbCloudySharp]
            ["@material-ui/icons/WbCloudyTwoTone" :default WbCloudyTwoTone]
            ["@material-ui/icons/WbIncandescent" :default WbIncandescent]
            ["@material-ui/icons/WbIncandescentOutlined" :default WbIncandescentOutlined]
            ["@material-ui/icons/WbIncandescentRounded" :default WbIncandescentRounded]
            ["@material-ui/icons/WbIncandescentSharp" :default WbIncandescentSharp]
            ["@material-ui/icons/WbIncandescentTwoTone" :default WbIncandescentTwoTone]
            ["@material-ui/icons/WbIridescent" :default WbIridescent]
            ["@material-ui/icons/WbIridescentOutlined" :default WbIridescentOutlined]
            ["@material-ui/icons/WbIridescentRounded" :default WbIridescentRounded]
            ["@material-ui/icons/WbIridescentSharp" :default WbIridescentSharp]
            ["@material-ui/icons/WbIridescentTwoTone" :default WbIridescentTwoTone]
            ["@material-ui/icons/WbSunny" :default WbSunny]
            ["@material-ui/icons/WbSunnyOutlined" :default WbSunnyOutlined]
            ["@material-ui/icons/WbSunnyRounded" :default WbSunnyRounded]
            ["@material-ui/icons/WbSunnySharp" :default WbSunnySharp]
            ["@material-ui/icons/WbSunnyTwoTone" :default WbSunnyTwoTone]
            ["@material-ui/icons/Wc" :default Wc]
            ["@material-ui/icons/WcOutlined" :default WcOutlined]
            ["@material-ui/icons/WcRounded" :default WcRounded]
            ["@material-ui/icons/WcSharp" :default WcSharp]
            ["@material-ui/icons/WcTwoTone" :default WcTwoTone]
            ["@material-ui/icons/Web" :default Web]
            ["@material-ui/icons/WebAsset" :default WebAsset]
            ["@material-ui/icons/WebAssetOutlined" :default WebAssetOutlined]
            ["@material-ui/icons/WebAssetRounded" :default WebAssetRounded]
            ["@material-ui/icons/WebAssetSharp" :default WebAssetSharp]
            ["@material-ui/icons/WebAssetTwoTone" :default WebAssetTwoTone]
            ["@material-ui/icons/WebOutlined" :default WebOutlined]
            ["@material-ui/icons/WebRounded" :default WebRounded]
            ["@material-ui/icons/WebSharp" :default WebSharp]
            ["@material-ui/icons/WebTwoTone" :default WebTwoTone]
            ["@material-ui/icons/Weekend" :default Weekend]
            ["@material-ui/icons/WeekendOutlined" :default WeekendOutlined]
            ["@material-ui/icons/WeekendRounded" :default WeekendRounded]
            ["@material-ui/icons/WeekendSharp" :default WeekendSharp]
            ["@material-ui/icons/WeekendTwoTone" :default WeekendTwoTone]
            ["@material-ui/icons/WhatsApp" :default WhatsApp]
            ["@material-ui/icons/Whatshot" :default Whatshot]
            ["@material-ui/icons/WhatshotOutlined" :default WhatshotOutlined]
            ["@material-ui/icons/WhatshotRounded" :default WhatshotRounded]
            ["@material-ui/icons/WhatshotSharp" :default WhatshotSharp]
            ["@material-ui/icons/WhatshotTwoTone" :default WhatshotTwoTone]
            ["@material-ui/icons/WhereToVote" :default WhereToVote]
            ["@material-ui/icons/WhereToVoteOutlined" :default WhereToVoteOutlined]
            ["@material-ui/icons/WhereToVoteRounded" :default WhereToVoteRounded]
            ["@material-ui/icons/WhereToVoteSharp" :default WhereToVoteSharp]
            ["@material-ui/icons/WhereToVoteTwoTone" :default WhereToVoteTwoTone]
            ["@material-ui/icons/Widgets" :default Widgets]
            ["@material-ui/icons/WidgetsOutlined" :default WidgetsOutlined]
            ["@material-ui/icons/WidgetsRounded" :default WidgetsRounded]
            ["@material-ui/icons/WidgetsSharp" :default WidgetsSharp]
            ["@material-ui/icons/WidgetsTwoTone" :default WidgetsTwoTone]
            ["@material-ui/icons/Wifi" :default Wifi]
            ["@material-ui/icons/WifiLock" :default WifiLock]
            ["@material-ui/icons/WifiLockOutlined" :default WifiLockOutlined]
            ["@material-ui/icons/WifiLockRounded" :default WifiLockRounded]
            ["@material-ui/icons/WifiLockSharp" :default WifiLockSharp]
            ["@material-ui/icons/WifiLockTwoTone" :default WifiLockTwoTone]
            ["@material-ui/icons/WifiOff" :default WifiOff]
            ["@material-ui/icons/WifiOffOutlined" :default WifiOffOutlined]
            ["@material-ui/icons/WifiOffRounded" :default WifiOffRounded]
            ["@material-ui/icons/WifiOffSharp" :default WifiOffSharp]
            ["@material-ui/icons/WifiOffTwoTone" :default WifiOffTwoTone]
            ["@material-ui/icons/WifiOutlined" :default WifiOutlined]
            ["@material-ui/icons/WifiRounded" :default WifiRounded]
            ["@material-ui/icons/WifiSharp" :default WifiSharp]
            ["@material-ui/icons/WifiTethering" :default WifiTethering]
            ["@material-ui/icons/WifiTetheringOutlined" :default WifiTetheringOutlined]
            ["@material-ui/icons/WifiTetheringRounded" :default WifiTetheringRounded]
            ["@material-ui/icons/WifiTetheringSharp" :default WifiTetheringSharp]
            ["@material-ui/icons/WifiTetheringTwoTone" :default WifiTetheringTwoTone]
            ["@material-ui/icons/WifiTwoTone" :default WifiTwoTone]
            ["@material-ui/icons/Work" :default Work]
            ["@material-ui/icons/WorkOff" :default WorkOff]
            ["@material-ui/icons/WorkOffOutlined" :default WorkOffOutlined]
            ["@material-ui/icons/WorkOffRounded" :default WorkOffRounded]
            ["@material-ui/icons/WorkOffSharp" :default WorkOffSharp]
            ["@material-ui/icons/WorkOffTwoTone" :default WorkOffTwoTone]
            ["@material-ui/icons/WorkOutline" :default WorkOutline]
            ["@material-ui/icons/WorkOutlined" :default WorkOutlined]
            ["@material-ui/icons/WorkOutlineOutlined" :default WorkOutlineOutlined]
            ["@material-ui/icons/WorkOutlineRounded" :default WorkOutlineRounded]
            ["@material-ui/icons/WorkOutlineSharp" :default WorkOutlineSharp]
            ["@material-ui/icons/WorkOutlineTwoTone" :default WorkOutlineTwoTone]
            ["@material-ui/icons/WorkRounded" :default WorkRounded]
            ["@material-ui/icons/WorkSharp" :default WorkSharp]
            ["@material-ui/icons/WorkTwoTone" :default WorkTwoTone]
            ["@material-ui/icons/WrapText" :default WrapText]
            ["@material-ui/icons/WrapTextOutlined" :default WrapTextOutlined]
            ["@material-ui/icons/WrapTextRounded" :default WrapTextRounded]
            ["@material-ui/icons/WrapTextSharp" :default WrapTextSharp]
            ["@material-ui/icons/WrapTextTwoTone" :default WrapTextTwoTone]
            ["@material-ui/icons/YouTube" :default YouTube]
            ["@material-ui/icons/YoutubeSearchedFor" :default YoutubeSearchedFor]
            ["@material-ui/icons/YoutubeSearchedForOutlined" :default YoutubeSearchedForOutlined]
            ["@material-ui/icons/YoutubeSearchedForRounded" :default YoutubeSearchedForRounded]
            ["@material-ui/icons/YoutubeSearchedForSharp" :default YoutubeSearchedForSharp]
            ["@material-ui/icons/YoutubeSearchedForTwoTone" :default YoutubeSearchedForTwoTone]
            ["@material-ui/icons/ZoomIn" :default ZoomIn]
            ["@material-ui/icons/ZoomInOutlined" :default ZoomInOutlined]
            ["@material-ui/icons/ZoomInRounded" :default ZoomInRounded]
            ["@material-ui/icons/ZoomInSharp" :default ZoomInSharp]
            ["@material-ui/icons/ZoomInTwoTone" :default ZoomInTwoTone]
            ["@material-ui/icons/ZoomOut" :default ZoomOut]
            ["@material-ui/icons/ZoomOutMap" :default ZoomOutMap]
            ["@material-ui/icons/ZoomOutMapOutlined" :default ZoomOutMapOutlined]
            ["@material-ui/icons/ZoomOutMapRounded" :default ZoomOutMapRounded]
            ["@material-ui/icons/ZoomOutMapSharp" :default ZoomOutMapSharp]
            ["@material-ui/icons/ZoomOutMapTwoTone" :default ZoomOutMapTwoTone]
            ["@material-ui/icons/ZoomOutOutlined" :default ZoomOutOutlined]
            ["@material-ui/icons/ZoomOutRounded" :default ZoomOutRounded]
            ["@material-ui/icons/ZoomOutSharp" :default ZoomOutSharp]
            ["@material-ui/icons/ZoomOutTwoTone" :default ZoomOutTwoTone]))

(def access-alarm (interop/react-factory AccessAlarm))
(def access-alarm-outlined (interop/react-factory AccessAlarmOutlined))
(def access-alarm-rounded (interop/react-factory AccessAlarmRounded))
(def access-alarms (interop/react-factory AccessAlarms))
(def access-alarm-sharp (interop/react-factory AccessAlarmSharp))
(def access-alarms-outlined (interop/react-factory AccessAlarmsOutlined))
(def access-alarms-rounded (interop/react-factory AccessAlarmsRounded))
(def access-alarms-sharp (interop/react-factory AccessAlarmsSharp))
(def access-alarms-two-tone (interop/react-factory AccessAlarmsTwoTone))
(def access-alarm-two-tone (interop/react-factory AccessAlarmTwoTone))
(def accessibility (interop/react-factory Accessibility))
(def accessibility-new (interop/react-factory AccessibilityNew))
(def accessibility-new-outlined (interop/react-factory AccessibilityNewOutlined))
(def accessibility-new-rounded (interop/react-factory AccessibilityNewRounded))
(def accessibility-new-sharp (interop/react-factory AccessibilityNewSharp))
(def accessibility-new-two-tone (interop/react-factory AccessibilityNewTwoTone))
(def accessibility-outlined (interop/react-factory AccessibilityOutlined))
(def accessibility-rounded (interop/react-factory AccessibilityRounded))
(def accessibility-sharp (interop/react-factory AccessibilitySharp))
(def accessibility-two-tone (interop/react-factory AccessibilityTwoTone))
(def accessible (interop/react-factory Accessible))
(def accessible-forward (interop/react-factory AccessibleForward))
(def accessible-forward-outlined (interop/react-factory AccessibleForwardOutlined))
(def accessible-forward-rounded (interop/react-factory AccessibleForwardRounded))
(def accessible-forward-sharp (interop/react-factory AccessibleForwardSharp))
(def accessible-forward-two-tone (interop/react-factory AccessibleForwardTwoTone))
(def accessible-outlined (interop/react-factory AccessibleOutlined))
(def accessible-rounded (interop/react-factory AccessibleRounded))
(def accessible-sharp (interop/react-factory AccessibleSharp))
(def accessible-two-tone (interop/react-factory AccessibleTwoTone))
(def access-time (interop/react-factory AccessTime))
(def access-time-outlined (interop/react-factory AccessTimeOutlined))
(def access-time-rounded (interop/react-factory AccessTimeRounded))
(def access-time-sharp (interop/react-factory AccessTimeSharp))
(def access-time-two-tone (interop/react-factory AccessTimeTwoTone))
(def account-balance (interop/react-factory AccountBalance))
(def account-balance-outlined (interop/react-factory AccountBalanceOutlined))
(def account-balance-rounded (interop/react-factory AccountBalanceRounded))
(def account-balance-sharp (interop/react-factory AccountBalanceSharp))
(def account-balance-two-tone (interop/react-factory AccountBalanceTwoTone))
(def account-balance-wallet (interop/react-factory AccountBalanceWallet))
(def account-balance-wallet-outlined (interop/react-factory AccountBalanceWalletOutlined))
(def account-balance-wallet-rounded (interop/react-factory AccountBalanceWalletRounded))
(def account-balance-wallet-sharp (interop/react-factory AccountBalanceWalletSharp))
(def account-balance-wallet-two-tone (interop/react-factory AccountBalanceWalletTwoTone))
(def account-box (interop/react-factory AccountBox))
(def account-box-outlined (interop/react-factory AccountBoxOutlined))
(def account-box-rounded (interop/react-factory AccountBoxRounded))
(def account-box-sharp (interop/react-factory AccountBoxSharp))
(def account-box-two-tone (interop/react-factory AccountBoxTwoTone))
(def account-circle (interop/react-factory AccountCircle))
(def account-circle-outlined (interop/react-factory AccountCircleOutlined))
(def account-circle-rounded (interop/react-factory AccountCircleRounded))
(def account-circle-sharp (interop/react-factory AccountCircleSharp))
(def account-circle-two-tone (interop/react-factory AccountCircleTwoTone))
(def account-tree (interop/react-factory AccountTree))
(def account-tree-outlined (interop/react-factory AccountTreeOutlined))
(def account-tree-rounded (interop/react-factory AccountTreeRounded))
(def account-tree-sharp (interop/react-factory AccountTreeSharp))
(def account-tree-two-tone (interop/react-factory AccountTreeTwoTone))
(def ac-unit (interop/react-factory AcUnit))
(def ac-unit-outlined (interop/react-factory AcUnitOutlined))
(def ac-unit-rounded (interop/react-factory AcUnitRounded))
(def ac-unit-sharp (interop/react-factory AcUnitSharp))
(def ac-unit-two-tone (interop/react-factory AcUnitTwoTone))
(def adb (interop/react-factory Adb))
(def adb-outlined (interop/react-factory AdbOutlined))
(def adb-rounded (interop/react-factory AdbRounded))
(def adb-sharp (interop/react-factory AdbSharp))
(def adb-two-tone (interop/react-factory AdbTwoTone))
(def add (interop/react-factory Add))
(def add-alarm (interop/react-factory AddAlarm))
(def add-alarm-outlined (interop/react-factory AddAlarmOutlined))
(def add-alarm-rounded (interop/react-factory AddAlarmRounded))
(def add-alarm-sharp (interop/react-factory AddAlarmSharp))
(def add-alarm-two-tone (interop/react-factory AddAlarmTwoTone))
(def add-alert (interop/react-factory AddAlert))
(def add-alert-outlined (interop/react-factory AddAlertOutlined))
(def add-alert-rounded (interop/react-factory AddAlertRounded))
(def add-alert-sharp (interop/react-factory AddAlertSharp))
(def add-alert-two-tone (interop/react-factory AddAlertTwoTone))
(def add-a-photo (interop/react-factory AddAPhoto))
(def add-a-photo-outlined (interop/react-factory AddAPhotoOutlined))
(def add-a-photo-rounded (interop/react-factory AddAPhotoRounded))
(def add-a-photo-sharp (interop/react-factory AddAPhotoSharp))
(def add-a-photo-two-tone (interop/react-factory AddAPhotoTwoTone))
(def add-box (interop/react-factory AddBox))
(def add-box-outlined (interop/react-factory AddBoxOutlined))
(def add-box-rounded (interop/react-factory AddBoxRounded))
(def add-box-sharp (interop/react-factory AddBoxSharp))
(def add-box-two-tone (interop/react-factory AddBoxTwoTone))
(def add-circle (interop/react-factory AddCircle))
(def add-circle-outline (interop/react-factory AddCircleOutline))
(def add-circle-outlined (interop/react-factory AddCircleOutlined))
(def add-circle-outline-outlined (interop/react-factory AddCircleOutlineOutlined))
(def add-circle-outline-rounded (interop/react-factory AddCircleOutlineRounded))
(def add-circle-outline-sharp (interop/react-factory AddCircleOutlineSharp))
(def add-circle-outline-two-tone (interop/react-factory AddCircleOutlineTwoTone))
(def add-circle-rounded (interop/react-factory AddCircleRounded))
(def add-circle-sharp (interop/react-factory AddCircleSharp))
(def add-circle-two-tone (interop/react-factory AddCircleTwoTone))
(def add-comment (interop/react-factory AddComment))
(def add-comment-outlined (interop/react-factory AddCommentOutlined))
(def add-comment-rounded (interop/react-factory AddCommentRounded))
(def add-comment-sharp (interop/react-factory AddCommentSharp))
(def add-comment-two-tone (interop/react-factory AddCommentTwoTone))
(def add-ic-call (interop/react-factory AddIcCall))
(def add-ic-call-outlined (interop/react-factory AddIcCallOutlined))
(def add-ic-call-rounded (interop/react-factory AddIcCallRounded))
(def add-ic-call-sharp (interop/react-factory AddIcCallSharp))
(def add-ic-call-two-tone (interop/react-factory AddIcCallTwoTone))
(def add-location (interop/react-factory AddLocation))
(def add-location-outlined (interop/react-factory AddLocationOutlined))
(def add-location-rounded (interop/react-factory AddLocationRounded))
(def add-location-sharp (interop/react-factory AddLocationSharp))
(def add-location-two-tone (interop/react-factory AddLocationTwoTone))
(def add-outlined (interop/react-factory AddOutlined))
(def add-photo-alternate (interop/react-factory AddPhotoAlternate))
(def add-photo-alternate-outlined (interop/react-factory AddPhotoAlternateOutlined))
(def add-photo-alternate-rounded (interop/react-factory AddPhotoAlternateRounded))
(def add-photo-alternate-sharp (interop/react-factory AddPhotoAlternateSharp))
(def add-photo-alternate-two-tone (interop/react-factory AddPhotoAlternateTwoTone))
(def add-rounded (interop/react-factory AddRounded))
(def add-sharp (interop/react-factory AddSharp))
(def add-shopping-cart (interop/react-factory AddShoppingCart))
(def add-shopping-cart-outlined (interop/react-factory AddShoppingCartOutlined))
(def add-shopping-cart-rounded (interop/react-factory AddShoppingCartRounded))
(def add-shopping-cart-sharp (interop/react-factory AddShoppingCartSharp))
(def add-shopping-cart-two-tone (interop/react-factory AddShoppingCartTwoTone))
(def add-to-home-screen (interop/react-factory AddToHomeScreen))
(def add-to-home-screen-outlined (interop/react-factory AddToHomeScreenOutlined))
(def add-to-home-screen-rounded (interop/react-factory AddToHomeScreenRounded))
(def add-to-home-screen-sharp (interop/react-factory AddToHomeScreenSharp))
(def add-to-home-screen-two-tone (interop/react-factory AddToHomeScreenTwoTone))
(def add-to-photos (interop/react-factory AddToPhotos))
(def add-to-photos-outlined (interop/react-factory AddToPhotosOutlined))
(def add-to-photos-rounded (interop/react-factory AddToPhotosRounded))
(def add-to-photos-sharp (interop/react-factory AddToPhotosSharp))
(def add-to-photos-two-tone (interop/react-factory AddToPhotosTwoTone))
(def add-to-queue (interop/react-factory AddToQueue))
(def add-to-queue-outlined (interop/react-factory AddToQueueOutlined))
(def add-to-queue-rounded (interop/react-factory AddToQueueRounded))
(def add-to-queue-sharp (interop/react-factory AddToQueueSharp))
(def add-to-queue-two-tone (interop/react-factory AddToQueueTwoTone))
(def add-two-tone (interop/react-factory AddTwoTone))
(def adjust (interop/react-factory Adjust))
(def adjust-outlined (interop/react-factory AdjustOutlined))
(def adjust-rounded (interop/react-factory AdjustRounded))
(def adjust-sharp (interop/react-factory AdjustSharp))
(def adjust-two-tone (interop/react-factory AdjustTwoTone))
(def airline-seat-flat (interop/react-factory AirlineSeatFlat))
(def airline-seat-flat-angled (interop/react-factory AirlineSeatFlatAngled))
(def airline-seat-flat-angled-outlined (interop/react-factory AirlineSeatFlatAngledOutlined))
(def airline-seat-flat-angled-rounded (interop/react-factory AirlineSeatFlatAngledRounded))
(def airline-seat-flat-angled-sharp (interop/react-factory AirlineSeatFlatAngledSharp))
(def airline-seat-flat-angled-two-tone (interop/react-factory AirlineSeatFlatAngledTwoTone))
(def airline-seat-flat-outlined (interop/react-factory AirlineSeatFlatOutlined))
(def airline-seat-flat-rounded (interop/react-factory AirlineSeatFlatRounded))
(def airline-seat-flat-sharp (interop/react-factory AirlineSeatFlatSharp))
(def airline-seat-flat-two-tone (interop/react-factory AirlineSeatFlatTwoTone))
(def airline-seat-individual-suite (interop/react-factory AirlineSeatIndividualSuite))
(def airline-seat-individual-suite-outlined (interop/react-factory AirlineSeatIndividualSuiteOutlined))
(def airline-seat-individual-suite-rounded (interop/react-factory AirlineSeatIndividualSuiteRounded))
(def airline-seat-individual-suite-sharp (interop/react-factory AirlineSeatIndividualSuiteSharp))
(def airline-seat-individual-suite-two-tone (interop/react-factory AirlineSeatIndividualSuiteTwoTone))
(def airline-seat-legroom-extra (interop/react-factory AirlineSeatLegroomExtra))
(def airline-seat-legroom-extra-outlined (interop/react-factory AirlineSeatLegroomExtraOutlined))
(def airline-seat-legroom-extra-rounded (interop/react-factory AirlineSeatLegroomExtraRounded))
(def airline-seat-legroom-extra-sharp (interop/react-factory AirlineSeatLegroomExtraSharp))
(def airline-seat-legroom-extra-two-tone (interop/react-factory AirlineSeatLegroomExtraTwoTone))
(def airline-seat-legroom-normal (interop/react-factory AirlineSeatLegroomNormal))
(def airline-seat-legroom-normal-outlined (interop/react-factory AirlineSeatLegroomNormalOutlined))
(def airline-seat-legroom-normal-rounded (interop/react-factory AirlineSeatLegroomNormalRounded))
(def airline-seat-legroom-normal-sharp (interop/react-factory AirlineSeatLegroomNormalSharp))
(def airline-seat-legroom-normal-two-tone (interop/react-factory AirlineSeatLegroomNormalTwoTone))
(def airline-seat-legroom-reduced (interop/react-factory AirlineSeatLegroomReduced))
(def airline-seat-legroom-reduced-outlined (interop/react-factory AirlineSeatLegroomReducedOutlined))
(def airline-seat-legroom-reduced-rounded (interop/react-factory AirlineSeatLegroomReducedRounded))
(def airline-seat-legroom-reduced-sharp (interop/react-factory AirlineSeatLegroomReducedSharp))
(def airline-seat-legroom-reduced-two-tone (interop/react-factory AirlineSeatLegroomReducedTwoTone))
(def airline-seat-recline-extra (interop/react-factory AirlineSeatReclineExtra))
(def airline-seat-recline-extra-outlined (interop/react-factory AirlineSeatReclineExtraOutlined))
(def airline-seat-recline-extra-rounded (interop/react-factory AirlineSeatReclineExtraRounded))
(def airline-seat-recline-extra-sharp (interop/react-factory AirlineSeatReclineExtraSharp))
(def airline-seat-recline-extra-two-tone (interop/react-factory AirlineSeatReclineExtraTwoTone))
(def airline-seat-recline-normal (interop/react-factory AirlineSeatReclineNormal))
(def airline-seat-recline-normal-outlined (interop/react-factory AirlineSeatReclineNormalOutlined))
(def airline-seat-recline-normal-rounded (interop/react-factory AirlineSeatReclineNormalRounded))
(def airline-seat-recline-normal-sharp (interop/react-factory AirlineSeatReclineNormalSharp))
(def airline-seat-recline-normal-two-tone (interop/react-factory AirlineSeatReclineNormalTwoTone))
(def airplanemode-active (interop/react-factory AirplanemodeActive))
(def airplanemode-active-outlined (interop/react-factory AirplanemodeActiveOutlined))
(def airplanemode-active-rounded (interop/react-factory AirplanemodeActiveRounded))
(def airplanemode-active-sharp (interop/react-factory AirplanemodeActiveSharp))
(def airplanemode-active-two-tone (interop/react-factory AirplanemodeActiveTwoTone))
(def airplanemode-inactive (interop/react-factory AirplanemodeInactive))
(def airplanemode-inactive-outlined (interop/react-factory AirplanemodeInactiveOutlined))
(def airplanemode-inactive-rounded (interop/react-factory AirplanemodeInactiveRounded))
(def airplanemode-inactive-sharp (interop/react-factory AirplanemodeInactiveSharp))
(def airplanemode-inactive-two-tone (interop/react-factory AirplanemodeInactiveTwoTone))
(def airplay (interop/react-factory Airplay))
(def airplay-outlined (interop/react-factory AirplayOutlined))
(def airplay-rounded (interop/react-factory AirplayRounded))
(def airplay-sharp (interop/react-factory AirplaySharp))
(def airplay-two-tone (interop/react-factory AirplayTwoTone))
(def airport-shuttle (interop/react-factory AirportShuttle))
(def airport-shuttle-outlined (interop/react-factory AirportShuttleOutlined))
(def airport-shuttle-rounded (interop/react-factory AirportShuttleRounded))
(def airport-shuttle-sharp (interop/react-factory AirportShuttleSharp))
(def airport-shuttle-two-tone (interop/react-factory AirportShuttleTwoTone))
(def alarm (interop/react-factory Alarm))
(def alarm-add (interop/react-factory AlarmAdd))
(def alarm-add-outlined (interop/react-factory AlarmAddOutlined))
(def alarm-add-rounded (interop/react-factory AlarmAddRounded))
(def alarm-add-sharp (interop/react-factory AlarmAddSharp))
(def alarm-add-two-tone (interop/react-factory AlarmAddTwoTone))
(def alarm-off (interop/react-factory AlarmOff))
(def alarm-off-outlined (interop/react-factory AlarmOffOutlined))
(def alarm-off-rounded (interop/react-factory AlarmOffRounded))
(def alarm-off-sharp (interop/react-factory AlarmOffSharp))
(def alarm-off-two-tone (interop/react-factory AlarmOffTwoTone))
(def alarm-on (interop/react-factory AlarmOn))
(def alarm-on-outlined (interop/react-factory AlarmOnOutlined))
(def alarm-on-rounded (interop/react-factory AlarmOnRounded))
(def alarm-on-sharp (interop/react-factory AlarmOnSharp))
(def alarm-on-two-tone (interop/react-factory AlarmOnTwoTone))
(def alarm-outlined (interop/react-factory AlarmOutlined))
(def alarm-rounded (interop/react-factory AlarmRounded))
(def alarm-sharp (interop/react-factory AlarmSharp))
(def alarm-two-tone (interop/react-factory AlarmTwoTone))
(def album (interop/react-factory Album))
(def album-outlined (interop/react-factory AlbumOutlined))
(def album-rounded (interop/react-factory AlbumRounded))
(def album-sharp (interop/react-factory AlbumSharp))
(def album-two-tone (interop/react-factory AlbumTwoTone))
(def all-inbox (interop/react-factory AllInbox))
(def all-inbox-outlined (interop/react-factory AllInboxOutlined))
(def all-inbox-rounded (interop/react-factory AllInboxRounded))
(def all-inbox-sharp (interop/react-factory AllInboxSharp))
(def all-inbox-two-tone (interop/react-factory AllInboxTwoTone))
(def all-inclusive (interop/react-factory AllInclusive))
(def all-inclusive-outlined (interop/react-factory AllInclusiveOutlined))
(def all-inclusive-rounded (interop/react-factory AllInclusiveRounded))
(def all-inclusive-sharp (interop/react-factory AllInclusiveSharp))
(def all-inclusive-two-tone (interop/react-factory AllInclusiveTwoTone))
(def all-out (interop/react-factory AllOut))
(def all-out-outlined (interop/react-factory AllOutOutlined))
(def all-out-rounded (interop/react-factory AllOutRounded))
(def all-out-sharp (interop/react-factory AllOutSharp))
(def all-out-two-tone (interop/react-factory AllOutTwoTone))
(def alternate-email (interop/react-factory AlternateEmail))
(def alternate-email-outlined (interop/react-factory AlternateEmailOutlined))
(def alternate-email-rounded (interop/react-factory AlternateEmailRounded))
(def alternate-email-sharp (interop/react-factory AlternateEmailSharp))
(def alternate-email-two-tone (interop/react-factory AlternateEmailTwoTone))
(def amp-stories (interop/react-factory AmpStories))
(def amp-stories-outlined (interop/react-factory AmpStoriesOutlined))
(def amp-stories-rounded (interop/react-factory AmpStoriesRounded))
(def amp-stories-sharp (interop/react-factory AmpStoriesSharp))
(def amp-stories-two-tone (interop/react-factory AmpStoriesTwoTone))
(def android (interop/react-factory Android))
(def android-outlined (interop/react-factory AndroidOutlined))
(def android-rounded (interop/react-factory AndroidRounded))
(def android-sharp (interop/react-factory AndroidSharp))
(def android-two-tone (interop/react-factory AndroidTwoTone))
(def announcement (interop/react-factory Announcement))
(def announcement-outlined (interop/react-factory AnnouncementOutlined))
(def announcement-rounded (interop/react-factory AnnouncementRounded))
(def announcement-sharp (interop/react-factory AnnouncementSharp))
(def announcement-two-tone (interop/react-factory AnnouncementTwoTone))
(def apartment (interop/react-factory Apartment))
(def apartment-outlined (interop/react-factory ApartmentOutlined))
(def apartment-rounded (interop/react-factory ApartmentRounded))
(def apartment-sharp (interop/react-factory ApartmentSharp))
(def apartment-two-tone (interop/react-factory ApartmentTwoTone))
(def apple (interop/react-factory Apple))
(def apps (interop/react-factory Apps))
(def apps-outlined (interop/react-factory AppsOutlined))
(def apps-rounded (interop/react-factory AppsRounded))
(def apps-sharp (interop/react-factory AppsSharp))
(def apps-two-tone (interop/react-factory AppsTwoTone))
(def archive (interop/react-factory Archive))
(def archive-outlined (interop/react-factory ArchiveOutlined))
(def archive-rounded (interop/react-factory ArchiveRounded))
(def archive-sharp (interop/react-factory ArchiveSharp))
(def archive-two-tone (interop/react-factory ArchiveTwoTone))
(def arrow-back (interop/react-factory ArrowBack))
(def arrow-back-ios (interop/react-factory ArrowBackIos))
(def arrow-back-ios-outlined (interop/react-factory ArrowBackIosOutlined))
(def arrow-back-ios-rounded (interop/react-factory ArrowBackIosRounded))
(def arrow-back-ios-sharp (interop/react-factory ArrowBackIosSharp))
(def arrow-back-ios-two-tone (interop/react-factory ArrowBackIosTwoTone))
(def arrow-back-outlined (interop/react-factory ArrowBackOutlined))
(def arrow-back-rounded (interop/react-factory ArrowBackRounded))
(def arrow-back-sharp (interop/react-factory ArrowBackSharp))
(def arrow-back-two-tone (interop/react-factory ArrowBackTwoTone))
(def arrow-downward (interop/react-factory ArrowDownward))
(def arrow-downward-outlined (interop/react-factory ArrowDownwardOutlined))
(def arrow-downward-rounded (interop/react-factory ArrowDownwardRounded))
(def arrow-downward-sharp (interop/react-factory ArrowDownwardSharp))
(def arrow-downward-two-tone (interop/react-factory ArrowDownwardTwoTone))
(def arrow-drop-down (interop/react-factory ArrowDropDown))
(def arrow-drop-down-circle (interop/react-factory ArrowDropDownCircle))
(def arrow-drop-down-circle-outlined (interop/react-factory ArrowDropDownCircleOutlined))
(def arrow-drop-down-circle-rounded (interop/react-factory ArrowDropDownCircleRounded))
(def arrow-drop-down-circle-sharp (interop/react-factory ArrowDropDownCircleSharp))
(def arrow-drop-down-circle-two-tone (interop/react-factory ArrowDropDownCircleTwoTone))
(def arrow-drop-down-outlined (interop/react-factory ArrowDropDownOutlined))
(def arrow-drop-down-rounded (interop/react-factory ArrowDropDownRounded))
(def arrow-drop-down-sharp (interop/react-factory ArrowDropDownSharp))
(def arrow-drop-down-two-tone (interop/react-factory ArrowDropDownTwoTone))
(def arrow-drop-up (interop/react-factory ArrowDropUp))
(def arrow-drop-up-outlined (interop/react-factory ArrowDropUpOutlined))
(def arrow-drop-up-rounded (interop/react-factory ArrowDropUpRounded))
(def arrow-drop-up-sharp (interop/react-factory ArrowDropUpSharp))
(def arrow-drop-up-two-tone (interop/react-factory ArrowDropUpTwoTone))
(def arrow-forward (interop/react-factory ArrowForward))
(def arrow-forward-ios (interop/react-factory ArrowForwardIos))
(def arrow-forward-ios-outlined (interop/react-factory ArrowForwardIosOutlined))
(def arrow-forward-ios-rounded (interop/react-factory ArrowForwardIosRounded))
(def arrow-forward-ios-sharp (interop/react-factory ArrowForwardIosSharp))
(def arrow-forward-ios-two-tone (interop/react-factory ArrowForwardIosTwoTone))
(def arrow-forward-outlined (interop/react-factory ArrowForwardOutlined))
(def arrow-forward-rounded (interop/react-factory ArrowForwardRounded))
(def arrow-forward-sharp (interop/react-factory ArrowForwardSharp))
(def arrow-forward-two-tone (interop/react-factory ArrowForwardTwoTone))
(def arrow-left (interop/react-factory ArrowLeft))
(def arrow-left-outlined (interop/react-factory ArrowLeftOutlined))
(def arrow-left-rounded (interop/react-factory ArrowLeftRounded))
(def arrow-left-sharp (interop/react-factory ArrowLeftSharp))
(def arrow-left-two-tone (interop/react-factory ArrowLeftTwoTone))
(def arrow-right (interop/react-factory ArrowRight))
(def arrow-right-alt (interop/react-factory ArrowRightAlt))
(def arrow-right-alt-outlined (interop/react-factory ArrowRightAltOutlined))
(def arrow-right-alt-rounded (interop/react-factory ArrowRightAltRounded))
(def arrow-right-alt-sharp (interop/react-factory ArrowRightAltSharp))
(def arrow-right-alt-two-tone (interop/react-factory ArrowRightAltTwoTone))
(def arrow-right-outlined (interop/react-factory ArrowRightOutlined))
(def arrow-right-rounded (interop/react-factory ArrowRightRounded))
(def arrow-right-sharp (interop/react-factory ArrowRightSharp))
(def arrow-right-two-tone (interop/react-factory ArrowRightTwoTone))
(def arrow-upward (interop/react-factory ArrowUpward))
(def arrow-upward-outlined (interop/react-factory ArrowUpwardOutlined))
(def arrow-upward-rounded (interop/react-factory ArrowUpwardRounded))
(def arrow-upward-sharp (interop/react-factory ArrowUpwardSharp))
(def arrow-upward-two-tone (interop/react-factory ArrowUpwardTwoTone))
(def art-track (interop/react-factory ArtTrack))
(def art-track-outlined (interop/react-factory ArtTrackOutlined))
(def art-track-rounded (interop/react-factory ArtTrackRounded))
(def art-track-sharp (interop/react-factory ArtTrackSharp))
(def art-track-two-tone (interop/react-factory ArtTrackTwoTone))
(def aspect-ratio (interop/react-factory AspectRatio))
(def aspect-ratio-outlined (interop/react-factory AspectRatioOutlined))
(def aspect-ratio-rounded (interop/react-factory AspectRatioRounded))
(def aspect-ratio-sharp (interop/react-factory AspectRatioSharp))
(def aspect-ratio-two-tone (interop/react-factory AspectRatioTwoTone))
(def assessment (interop/react-factory Assessment))
(def assessment-outlined (interop/react-factory AssessmentOutlined))
(def assessment-rounded (interop/react-factory AssessmentRounded))
(def assessment-sharp (interop/react-factory AssessmentSharp))
(def assessment-two-tone (interop/react-factory AssessmentTwoTone))
(def assignment (interop/react-factory Assignment))
(def assignment-ind (interop/react-factory AssignmentInd))
(def assignment-ind-outlined (interop/react-factory AssignmentIndOutlined))
(def assignment-ind-rounded (interop/react-factory AssignmentIndRounded))
(def assignment-ind-sharp (interop/react-factory AssignmentIndSharp))
(def assignment-ind-two-tone (interop/react-factory AssignmentIndTwoTone))
(def assignment-late (interop/react-factory AssignmentLate))
(def assignment-late-outlined (interop/react-factory AssignmentLateOutlined))
(def assignment-late-rounded (interop/react-factory AssignmentLateRounded))
(def assignment-late-sharp (interop/react-factory AssignmentLateSharp))
(def assignment-late-two-tone (interop/react-factory AssignmentLateTwoTone))
(def assignment-outlined (interop/react-factory AssignmentOutlined))
(def assignment-return (interop/react-factory AssignmentReturn))
(def assignment-returned (interop/react-factory AssignmentReturned))
(def assignment-returned-outlined (interop/react-factory AssignmentReturnedOutlined))
(def assignment-returned-rounded (interop/react-factory AssignmentReturnedRounded))
(def assignment-returned-sharp (interop/react-factory AssignmentReturnedSharp))
(def assignment-returned-two-tone (interop/react-factory AssignmentReturnedTwoTone))
(def assignment-return-outlined (interop/react-factory AssignmentReturnOutlined))
(def assignment-return-rounded (interop/react-factory AssignmentReturnRounded))
(def assignment-return-sharp (interop/react-factory AssignmentReturnSharp))
(def assignment-return-two-tone (interop/react-factory AssignmentReturnTwoTone))
(def assignment-rounded (interop/react-factory AssignmentRounded))
(def assignment-sharp (interop/react-factory AssignmentSharp))
(def assignment-turned-in (interop/react-factory AssignmentTurnedIn))
(def assignment-turned-in-outlined (interop/react-factory AssignmentTurnedInOutlined))
(def assignment-turned-in-rounded (interop/react-factory AssignmentTurnedInRounded))
(def assignment-turned-in-sharp (interop/react-factory AssignmentTurnedInSharp))
(def assignment-turned-in-two-tone (interop/react-factory AssignmentTurnedInTwoTone))
(def assignment-two-tone (interop/react-factory AssignmentTwoTone))
(def assistant (interop/react-factory Assistant))
(def assistant-outlined (interop/react-factory AssistantOutlined))
(def assistant-photo (interop/react-factory AssistantPhoto))
(def assistant-photo-outlined (interop/react-factory AssistantPhotoOutlined))
(def assistant-photo-rounded (interop/react-factory AssistantPhotoRounded))
(def assistant-photo-sharp (interop/react-factory AssistantPhotoSharp))
(def assistant-photo-two-tone (interop/react-factory AssistantPhotoTwoTone))
(def assistant-rounded (interop/react-factory AssistantRounded))
(def assistant-sharp (interop/react-factory AssistantSharp))
(def assistant-two-tone (interop/react-factory AssistantTwoTone))
(def atm (interop/react-factory Atm))
(def atm-outlined (interop/react-factory AtmOutlined))
(def atm-rounded (interop/react-factory AtmRounded))
(def atm-sharp (interop/react-factory AtmSharp))
(def atm-two-tone (interop/react-factory AtmTwoTone))
(def attach-file (interop/react-factory AttachFile))
(def attach-file-outlined (interop/react-factory AttachFileOutlined))
(def attach-file-rounded (interop/react-factory AttachFileRounded))
(def attach-file-sharp (interop/react-factory AttachFileSharp))
(def attach-file-two-tone (interop/react-factory AttachFileTwoTone))
(def attachment (interop/react-factory Attachment))
(def attachment-outlined (interop/react-factory AttachmentOutlined))
(def attachment-rounded (interop/react-factory AttachmentRounded))
(def attachment-sharp (interop/react-factory AttachmentSharp))
(def attachment-two-tone (interop/react-factory AttachmentTwoTone))
(def attach-money (interop/react-factory AttachMoney))
(def attach-money-outlined (interop/react-factory AttachMoneyOutlined))
(def attach-money-rounded (interop/react-factory AttachMoneyRounded))
(def attach-money-sharp (interop/react-factory AttachMoneySharp))
(def attach-money-two-tone (interop/react-factory AttachMoneyTwoTone))
(def audiotrack (interop/react-factory Audiotrack))
(def audiotrack-outlined (interop/react-factory AudiotrackOutlined))
(def audiotrack-rounded (interop/react-factory AudiotrackRounded))
(def audiotrack-sharp (interop/react-factory AudiotrackSharp))
(def audiotrack-two-tone (interop/react-factory AudiotrackTwoTone))
(def autorenew (interop/react-factory Autorenew))
(def autorenew-outlined (interop/react-factory AutorenewOutlined))
(def autorenew-rounded (interop/react-factory AutorenewRounded))
(def autorenew-sharp (interop/react-factory AutorenewSharp))
(def autorenew-two-tone (interop/react-factory AutorenewTwoTone))
(def av-timer (interop/react-factory AvTimer))
(def av-timer-outlined (interop/react-factory AvTimerOutlined))
(def av-timer-rounded (interop/react-factory AvTimerRounded))
(def av-timer-sharp (interop/react-factory AvTimerSharp))
(def av-timer-two-tone (interop/react-factory AvTimerTwoTone))
(def backspace (interop/react-factory Backspace))
(def backspace-outlined (interop/react-factory BackspaceOutlined))
(def backspace-rounded (interop/react-factory BackspaceRounded))
(def backspace-sharp (interop/react-factory BackspaceSharp))
(def backspace-two-tone (interop/react-factory BackspaceTwoTone))
(def backup (interop/react-factory Backup))
(def backup-outlined (interop/react-factory BackupOutlined))
(def backup-rounded (interop/react-factory BackupRounded))
(def backup-sharp (interop/react-factory BackupSharp))
(def backup-two-tone (interop/react-factory BackupTwoTone))
(def ballot (interop/react-factory Ballot))
(def ballot-outlined (interop/react-factory BallotOutlined))
(def ballot-rounded (interop/react-factory BallotRounded))
(def ballot-sharp (interop/react-factory BallotSharp))
(def ballot-two-tone (interop/react-factory BallotTwoTone))
(def bar-chart (interop/react-factory BarChart))
(def bar-chart-outlined (interop/react-factory BarChartOutlined))
(def bar-chart-rounded (interop/react-factory BarChartRounded))
(def bar-chart-sharp (interop/react-factory BarChartSharp))
(def bar-chart-two-tone (interop/react-factory BarChartTwoTone))
(def bathtub (interop/react-factory Bathtub))
(def bathtub-outlined (interop/react-factory BathtubOutlined))
(def bathtub-rounded (interop/react-factory BathtubRounded))
(def bathtub-sharp (interop/react-factory BathtubSharp))
(def bathtub-two-tone (interop/react-factory BathtubTwoTone))
(def battery20 (interop/react-factory Battery20))
(def battery20-outlined (interop/react-factory Battery20Outlined))
(def battery20-rounded (interop/react-factory Battery20Rounded))
(def battery20-sharp (interop/react-factory Battery20Sharp))
(def battery20-two-tone (interop/react-factory Battery20TwoTone))
(def battery30 (interop/react-factory Battery30))
(def battery30-outlined (interop/react-factory Battery30Outlined))
(def battery30-rounded (interop/react-factory Battery30Rounded))
(def battery30-sharp (interop/react-factory Battery30Sharp))
(def battery30-two-tone (interop/react-factory Battery30TwoTone))
(def battery50 (interop/react-factory Battery50))
(def battery50-outlined (interop/react-factory Battery50Outlined))
(def battery50-rounded (interop/react-factory Battery50Rounded))
(def battery50-sharp (interop/react-factory Battery50Sharp))
(def battery50-two-tone (interop/react-factory Battery50TwoTone))
(def battery60 (interop/react-factory Battery60))
(def battery60-outlined (interop/react-factory Battery60Outlined))
(def battery60-rounded (interop/react-factory Battery60Rounded))
(def battery60-sharp (interop/react-factory Battery60Sharp))
(def battery60-two-tone (interop/react-factory Battery60TwoTone))
(def battery80 (interop/react-factory Battery80))
(def battery80-outlined (interop/react-factory Battery80Outlined))
(def battery80-rounded (interop/react-factory Battery80Rounded))
(def battery80-sharp (interop/react-factory Battery80Sharp))
(def battery80-two-tone (interop/react-factory Battery80TwoTone))
(def battery90 (interop/react-factory Battery90))
(def battery90-outlined (interop/react-factory Battery90Outlined))
(def battery90-rounded (interop/react-factory Battery90Rounded))
(def battery90-sharp (interop/react-factory Battery90Sharp))
(def battery90-two-tone (interop/react-factory Battery90TwoTone))
(def battery-alert (interop/react-factory BatteryAlert))
(def battery-alert-outlined (interop/react-factory BatteryAlertOutlined))
(def battery-alert-rounded (interop/react-factory BatteryAlertRounded))
(def battery-alert-sharp (interop/react-factory BatteryAlertSharp))
(def battery-alert-two-tone (interop/react-factory BatteryAlertTwoTone))
(def battery-charging20 (interop/react-factory BatteryCharging20))
(def battery-charging20-outlined (interop/react-factory BatteryCharging20Outlined))
(def battery-charging20-rounded (interop/react-factory BatteryCharging20Rounded))
(def battery-charging20-sharp (interop/react-factory BatteryCharging20Sharp))
(def battery-charging20-two-tone (interop/react-factory BatteryCharging20TwoTone))
(def battery-charging30 (interop/react-factory BatteryCharging30))
(def battery-charging30-outlined (interop/react-factory BatteryCharging30Outlined))
(def battery-charging30-rounded (interop/react-factory BatteryCharging30Rounded))
(def battery-charging30-sharp (interop/react-factory BatteryCharging30Sharp))
(def battery-charging30-two-tone (interop/react-factory BatteryCharging30TwoTone))
(def battery-charging50 (interop/react-factory BatteryCharging50))
(def battery-charging50-outlined (interop/react-factory BatteryCharging50Outlined))
(def battery-charging50-rounded (interop/react-factory BatteryCharging50Rounded))
(def battery-charging50-sharp (interop/react-factory BatteryCharging50Sharp))
(def battery-charging50-two-tone (interop/react-factory BatteryCharging50TwoTone))
(def battery-charging60 (interop/react-factory BatteryCharging60))
(def battery-charging60-outlined (interop/react-factory BatteryCharging60Outlined))
(def battery-charging60-rounded (interop/react-factory BatteryCharging60Rounded))
(def battery-charging60-sharp (interop/react-factory BatteryCharging60Sharp))
(def battery-charging60-two-tone (interop/react-factory BatteryCharging60TwoTone))
(def battery-charging80 (interop/react-factory BatteryCharging80))
(def battery-charging80-outlined (interop/react-factory BatteryCharging80Outlined))
(def battery-charging80-rounded (interop/react-factory BatteryCharging80Rounded))
(def battery-charging80-sharp (interop/react-factory BatteryCharging80Sharp))
(def battery-charging80-two-tone (interop/react-factory BatteryCharging80TwoTone))
(def battery-charging90 (interop/react-factory BatteryCharging90))
(def battery-charging90-outlined (interop/react-factory BatteryCharging90Outlined))
(def battery-charging90-rounded (interop/react-factory BatteryCharging90Rounded))
(def battery-charging90-sharp (interop/react-factory BatteryCharging90Sharp))
(def battery-charging90-two-tone (interop/react-factory BatteryCharging90TwoTone))
(def battery-charging-full (interop/react-factory BatteryChargingFull))
(def battery-charging-full-outlined (interop/react-factory BatteryChargingFullOutlined))
(def battery-charging-full-rounded (interop/react-factory BatteryChargingFullRounded))
(def battery-charging-full-sharp (interop/react-factory BatteryChargingFullSharp))
(def battery-charging-full-two-tone (interop/react-factory BatteryChargingFullTwoTone))
(def battery-full (interop/react-factory BatteryFull))
(def battery-full-outlined (interop/react-factory BatteryFullOutlined))
(def battery-full-rounded (interop/react-factory BatteryFullRounded))
(def battery-full-sharp (interop/react-factory BatteryFullSharp))
(def battery-full-two-tone (interop/react-factory BatteryFullTwoTone))
(def battery-std (interop/react-factory BatteryStd))
(def battery-std-outlined (interop/react-factory BatteryStdOutlined))
(def battery-std-rounded (interop/react-factory BatteryStdRounded))
(def battery-std-sharp (interop/react-factory BatteryStdSharp))
(def battery-std-two-tone (interop/react-factory BatteryStdTwoTone))
(def battery-unknown (interop/react-factory BatteryUnknown))
(def battery-unknown-outlined (interop/react-factory BatteryUnknownOutlined))
(def battery-unknown-rounded (interop/react-factory BatteryUnknownRounded))
(def battery-unknown-sharp (interop/react-factory BatteryUnknownSharp))
(def battery-unknown-two-tone (interop/react-factory BatteryUnknownTwoTone))
(def beach-access (interop/react-factory BeachAccess))
(def beach-access-outlined (interop/react-factory BeachAccessOutlined))
(def beach-access-rounded (interop/react-factory BeachAccessRounded))
(def beach-access-sharp (interop/react-factory BeachAccessSharp))
(def beach-access-two-tone (interop/react-factory BeachAccessTwoTone))
(def beenhere (interop/react-factory Beenhere))
(def beenhere-outlined (interop/react-factory BeenhereOutlined))
(def beenhere-rounded (interop/react-factory BeenhereRounded))
(def beenhere-sharp (interop/react-factory BeenhereSharp))
(def beenhere-two-tone (interop/react-factory BeenhereTwoTone))
(def block (interop/react-factory Block))
(def block-outlined (interop/react-factory BlockOutlined))
(def block-rounded (interop/react-factory BlockRounded))
(def block-sharp (interop/react-factory BlockSharp))
(def block-two-tone (interop/react-factory BlockTwoTone))
(def bluetooth (interop/react-factory Bluetooth))
(def bluetooth-audio (interop/react-factory BluetoothAudio))
(def bluetooth-audio-outlined (interop/react-factory BluetoothAudioOutlined))
(def bluetooth-audio-rounded (interop/react-factory BluetoothAudioRounded))
(def bluetooth-audio-sharp (interop/react-factory BluetoothAudioSharp))
(def bluetooth-audio-two-tone (interop/react-factory BluetoothAudioTwoTone))
(def bluetooth-connected (interop/react-factory BluetoothConnected))
(def bluetooth-connected-outlined (interop/react-factory BluetoothConnectedOutlined))
(def bluetooth-connected-rounded (interop/react-factory BluetoothConnectedRounded))
(def bluetooth-connected-sharp (interop/react-factory BluetoothConnectedSharp))
(def bluetooth-connected-two-tone (interop/react-factory BluetoothConnectedTwoTone))
(def bluetooth-disabled (interop/react-factory BluetoothDisabled))
(def bluetooth-disabled-outlined (interop/react-factory BluetoothDisabledOutlined))
(def bluetooth-disabled-rounded (interop/react-factory BluetoothDisabledRounded))
(def bluetooth-disabled-sharp (interop/react-factory BluetoothDisabledSharp))
(def bluetooth-disabled-two-tone (interop/react-factory BluetoothDisabledTwoTone))
(def bluetooth-outlined (interop/react-factory BluetoothOutlined))
(def bluetooth-rounded (interop/react-factory BluetoothRounded))
(def bluetooth-searching (interop/react-factory BluetoothSearching))
(def bluetooth-searching-outlined (interop/react-factory BluetoothSearchingOutlined))
(def bluetooth-searching-rounded (interop/react-factory BluetoothSearchingRounded))
(def bluetooth-searching-sharp (interop/react-factory BluetoothSearchingSharp))
(def bluetooth-searching-two-tone (interop/react-factory BluetoothSearchingTwoTone))
(def bluetooth-sharp (interop/react-factory BluetoothSharp))
(def bluetooth-two-tone (interop/react-factory BluetoothTwoTone))
(def blur-circular (interop/react-factory BlurCircular))
(def blur-circular-outlined (interop/react-factory BlurCircularOutlined))
(def blur-circular-rounded (interop/react-factory BlurCircularRounded))
(def blur-circular-sharp (interop/react-factory BlurCircularSharp))
(def blur-circular-two-tone (interop/react-factory BlurCircularTwoTone))
(def blur-linear (interop/react-factory BlurLinear))
(def blur-linear-outlined (interop/react-factory BlurLinearOutlined))
(def blur-linear-rounded (interop/react-factory BlurLinearRounded))
(def blur-linear-sharp (interop/react-factory BlurLinearSharp))
(def blur-linear-two-tone (interop/react-factory BlurLinearTwoTone))
(def blur-off (interop/react-factory BlurOff))
(def blur-off-outlined (interop/react-factory BlurOffOutlined))
(def blur-off-rounded (interop/react-factory BlurOffRounded))
(def blur-off-sharp (interop/react-factory BlurOffSharp))
(def blur-off-two-tone (interop/react-factory BlurOffTwoTone))
(def blur-on (interop/react-factory BlurOn))
(def blur-on-outlined (interop/react-factory BlurOnOutlined))
(def blur-on-rounded (interop/react-factory BlurOnRounded))
(def blur-on-sharp (interop/react-factory BlurOnSharp))
(def blur-on-two-tone (interop/react-factory BlurOnTwoTone))
(def book (interop/react-factory Book))
(def bookmark (interop/react-factory Bookmark))
(def bookmark-border (interop/react-factory BookmarkBorder))
(def bookmark-border-outlined (interop/react-factory BookmarkBorderOutlined))
(def bookmark-border-rounded (interop/react-factory BookmarkBorderRounded))
(def bookmark-border-sharp (interop/react-factory BookmarkBorderSharp))
(def bookmark-border-two-tone (interop/react-factory BookmarkBorderTwoTone))
(def bookmark-outlined (interop/react-factory BookmarkOutlined))
(def bookmark-rounded (interop/react-factory BookmarkRounded))
(def bookmarks (interop/react-factory Bookmarks))
(def bookmark-sharp (interop/react-factory BookmarkSharp))
(def bookmarks-outlined (interop/react-factory BookmarksOutlined))
(def bookmarks-rounded (interop/react-factory BookmarksRounded))
(def bookmarks-sharp (interop/react-factory BookmarksSharp))
(def bookmarks-two-tone (interop/react-factory BookmarksTwoTone))
(def bookmark-two-tone (interop/react-factory BookmarkTwoTone))
(def book-outlined (interop/react-factory BookOutlined))
(def book-rounded (interop/react-factory BookRounded))
(def book-sharp (interop/react-factory BookSharp))
(def book-two-tone (interop/react-factory BookTwoTone))
(def border-all (interop/react-factory BorderAll))
(def border-all-outlined (interop/react-factory BorderAllOutlined))
(def border-all-rounded (interop/react-factory BorderAllRounded))
(def border-all-sharp (interop/react-factory BorderAllSharp))
(def border-all-two-tone (interop/react-factory BorderAllTwoTone))
(def border-bottom (interop/react-factory BorderBottom))
(def border-bottom-outlined (interop/react-factory BorderBottomOutlined))
(def border-bottom-rounded (interop/react-factory BorderBottomRounded))
(def border-bottom-sharp (interop/react-factory BorderBottomSharp))
(def border-bottom-two-tone (interop/react-factory BorderBottomTwoTone))
(def border-clear (interop/react-factory BorderClear))
(def border-clear-outlined (interop/react-factory BorderClearOutlined))
(def border-clear-rounded (interop/react-factory BorderClearRounded))
(def border-clear-sharp (interop/react-factory BorderClearSharp))
(def border-clear-two-tone (interop/react-factory BorderClearTwoTone))
(def border-color (interop/react-factory BorderColor))
(def border-color-outlined (interop/react-factory BorderColorOutlined))
(def border-color-rounded (interop/react-factory BorderColorRounded))
(def border-color-sharp (interop/react-factory BorderColorSharp))
(def border-color-two-tone (interop/react-factory BorderColorTwoTone))
(def border-horizontal (interop/react-factory BorderHorizontal))
(def border-horizontal-outlined (interop/react-factory BorderHorizontalOutlined))
(def border-horizontal-rounded (interop/react-factory BorderHorizontalRounded))
(def border-horizontal-sharp (interop/react-factory BorderHorizontalSharp))
(def border-horizontal-two-tone (interop/react-factory BorderHorizontalTwoTone))
(def border-inner (interop/react-factory BorderInner))
(def border-inner-outlined (interop/react-factory BorderInnerOutlined))
(def border-inner-rounded (interop/react-factory BorderInnerRounded))
(def border-inner-sharp (interop/react-factory BorderInnerSharp))
(def border-inner-two-tone (interop/react-factory BorderInnerTwoTone))
(def border-left (interop/react-factory BorderLeft))
(def border-left-outlined (interop/react-factory BorderLeftOutlined))
(def border-left-rounded (interop/react-factory BorderLeftRounded))
(def border-left-sharp (interop/react-factory BorderLeftSharp))
(def border-left-two-tone (interop/react-factory BorderLeftTwoTone))
(def border-outer (interop/react-factory BorderOuter))
(def border-outer-outlined (interop/react-factory BorderOuterOutlined))
(def border-outer-rounded (interop/react-factory BorderOuterRounded))
(def border-outer-sharp (interop/react-factory BorderOuterSharp))
(def border-outer-two-tone (interop/react-factory BorderOuterTwoTone))
(def border-right (interop/react-factory BorderRight))
(def border-right-outlined (interop/react-factory BorderRightOutlined))
(def border-right-rounded (interop/react-factory BorderRightRounded))
(def border-right-sharp (interop/react-factory BorderRightSharp))
(def border-right-two-tone (interop/react-factory BorderRightTwoTone))
(def border-style (interop/react-factory BorderStyle))
(def border-style-outlined (interop/react-factory BorderStyleOutlined))
(def border-style-rounded (interop/react-factory BorderStyleRounded))
(def border-style-sharp (interop/react-factory BorderStyleSharp))
(def border-style-two-tone (interop/react-factory BorderStyleTwoTone))
(def border-top (interop/react-factory BorderTop))
(def border-top-outlined (interop/react-factory BorderTopOutlined))
(def border-top-rounded (interop/react-factory BorderTopRounded))
(def border-top-sharp (interop/react-factory BorderTopSharp))
(def border-top-two-tone (interop/react-factory BorderTopTwoTone))
(def border-vertical (interop/react-factory BorderVertical))
(def border-vertical-outlined (interop/react-factory BorderVerticalOutlined))
(def border-vertical-rounded (interop/react-factory BorderVerticalRounded))
(def border-vertical-sharp (interop/react-factory BorderVerticalSharp))
(def border-vertical-two-tone (interop/react-factory BorderVerticalTwoTone))
(def branding-watermark (interop/react-factory BrandingWatermark))
(def branding-watermark-outlined (interop/react-factory BrandingWatermarkOutlined))
(def branding-watermark-rounded (interop/react-factory BrandingWatermarkRounded))
(def branding-watermark-sharp (interop/react-factory BrandingWatermarkSharp))
(def branding-watermark-two-tone (interop/react-factory BrandingWatermarkTwoTone))
(def brightness1 (interop/react-factory Brightness1))
(def brightness1-outlined (interop/react-factory Brightness1Outlined))
(def brightness1-rounded (interop/react-factory Brightness1Rounded))
(def brightness1-sharp (interop/react-factory Brightness1Sharp))
(def brightness1-two-tone (interop/react-factory Brightness1TwoTone))
(def brightness2 (interop/react-factory Brightness2))
(def brightness2-outlined (interop/react-factory Brightness2Outlined))
(def brightness2-rounded (interop/react-factory Brightness2Rounded))
(def brightness2-sharp (interop/react-factory Brightness2Sharp))
(def brightness2-two-tone (interop/react-factory Brightness2TwoTone))
(def brightness3 (interop/react-factory Brightness3))
(def brightness3-outlined (interop/react-factory Brightness3Outlined))
(def brightness3-rounded (interop/react-factory Brightness3Rounded))
(def brightness3-sharp (interop/react-factory Brightness3Sharp))
(def brightness3-two-tone (interop/react-factory Brightness3TwoTone))
(def brightness4 (interop/react-factory Brightness4))
(def brightness4-outlined (interop/react-factory Brightness4Outlined))
(def brightness4-rounded (interop/react-factory Brightness4Rounded))
(def brightness4-sharp (interop/react-factory Brightness4Sharp))
(def brightness4-two-tone (interop/react-factory Brightness4TwoTone))
(def brightness5 (interop/react-factory Brightness5))
(def brightness5-outlined (interop/react-factory Brightness5Outlined))
(def brightness5-rounded (interop/react-factory Brightness5Rounded))
(def brightness5-sharp (interop/react-factory Brightness5Sharp))
(def brightness5-two-tone (interop/react-factory Brightness5TwoTone))
(def brightness6 (interop/react-factory Brightness6))
(def brightness6-outlined (interop/react-factory Brightness6Outlined))
(def brightness6-rounded (interop/react-factory Brightness6Rounded))
(def brightness6-sharp (interop/react-factory Brightness6Sharp))
(def brightness6-two-tone (interop/react-factory Brightness6TwoTone))
(def brightness7 (interop/react-factory Brightness7))
(def brightness7-outlined (interop/react-factory Brightness7Outlined))
(def brightness7-rounded (interop/react-factory Brightness7Rounded))
(def brightness7-sharp (interop/react-factory Brightness7Sharp))
(def brightness7-two-tone (interop/react-factory Brightness7TwoTone))
(def brightness-auto (interop/react-factory BrightnessAuto))
(def brightness-auto-outlined (interop/react-factory BrightnessAutoOutlined))
(def brightness-auto-rounded (interop/react-factory BrightnessAutoRounded))
(def brightness-auto-sharp (interop/react-factory BrightnessAutoSharp))
(def brightness-auto-two-tone (interop/react-factory BrightnessAutoTwoTone))
(def brightness-high (interop/react-factory BrightnessHigh))
(def brightness-high-outlined (interop/react-factory BrightnessHighOutlined))
(def brightness-high-rounded (interop/react-factory BrightnessHighRounded))
(def brightness-high-sharp (interop/react-factory BrightnessHighSharp))
(def brightness-high-two-tone (interop/react-factory BrightnessHighTwoTone))
(def brightness-low (interop/react-factory BrightnessLow))
(def brightness-low-outlined (interop/react-factory BrightnessLowOutlined))
(def brightness-low-rounded (interop/react-factory BrightnessLowRounded))
(def brightness-low-sharp (interop/react-factory BrightnessLowSharp))
(def brightness-low-two-tone (interop/react-factory BrightnessLowTwoTone))
(def brightness-medium (interop/react-factory BrightnessMedium))
(def brightness-medium-outlined (interop/react-factory BrightnessMediumOutlined))
(def brightness-medium-rounded (interop/react-factory BrightnessMediumRounded))
(def brightness-medium-sharp (interop/react-factory BrightnessMediumSharp))
(def brightness-medium-two-tone (interop/react-factory BrightnessMediumTwoTone))
(def broken-image (interop/react-factory BrokenImage))
(def broken-image-outlined (interop/react-factory BrokenImageOutlined))
(def broken-image-rounded (interop/react-factory BrokenImageRounded))
(def broken-image-sharp (interop/react-factory BrokenImageSharp))
(def broken-image-two-tone (interop/react-factory BrokenImageTwoTone))
(def brush (interop/react-factory Brush))
(def brush-outlined (interop/react-factory BrushOutlined))
(def brush-rounded (interop/react-factory BrushRounded))
(def brush-sharp (interop/react-factory BrushSharp))
(def brush-two-tone (interop/react-factory BrushTwoTone))
(def bubble-chart (interop/react-factory BubbleChart))
(def bubble-chart-outlined (interop/react-factory BubbleChartOutlined))
(def bubble-chart-rounded (interop/react-factory BubbleChartRounded))
(def bubble-chart-sharp (interop/react-factory BubbleChartSharp))
(def bubble-chart-two-tone (interop/react-factory BubbleChartTwoTone))
(def bug-report (interop/react-factory BugReport))
(def bug-report-outlined (interop/react-factory BugReportOutlined))
(def bug-report-rounded (interop/react-factory BugReportRounded))
(def bug-report-sharp (interop/react-factory BugReportSharp))
(def bug-report-two-tone (interop/react-factory BugReportTwoTone))
(def build (interop/react-factory Build))
(def build-outlined (interop/react-factory BuildOutlined))
(def build-rounded (interop/react-factory BuildRounded))
(def build-sharp (interop/react-factory BuildSharp))
(def build-two-tone (interop/react-factory BuildTwoTone))
(def burst-mode (interop/react-factory BurstMode))
(def burst-mode-outlined (interop/react-factory BurstModeOutlined))
(def burst-mode-rounded (interop/react-factory BurstModeRounded))
(def burst-mode-sharp (interop/react-factory BurstModeSharp))
(def burst-mode-two-tone (interop/react-factory BurstModeTwoTone))
(def business (interop/react-factory Business))
(def business-center (interop/react-factory BusinessCenter))
(def business-center-outlined (interop/react-factory BusinessCenterOutlined))
(def business-center-rounded (interop/react-factory BusinessCenterRounded))
(def business-center-sharp (interop/react-factory BusinessCenterSharp))
(def business-center-two-tone (interop/react-factory BusinessCenterTwoTone))
(def business-outlined (interop/react-factory BusinessOutlined))
(def business-rounded (interop/react-factory BusinessRounded))
(def business-sharp (interop/react-factory BusinessSharp))
(def business-two-tone (interop/react-factory BusinessTwoTone))
(def cached (interop/react-factory Cached))
(def cached-outlined (interop/react-factory CachedOutlined))
(def cached-rounded (interop/react-factory CachedRounded))
(def cached-sharp (interop/react-factory CachedSharp))
(def cached-two-tone (interop/react-factory CachedTwoTone))
(def cake (interop/react-factory Cake))
(def cake-outlined (interop/react-factory CakeOutlined))
(def cake-rounded (interop/react-factory CakeRounded))
(def cake-sharp (interop/react-factory CakeSharp))
(def cake-two-tone (interop/react-factory CakeTwoTone))
(def calendar-today (interop/react-factory CalendarToday))
(def calendar-today-outlined (interop/react-factory CalendarTodayOutlined))
(def calendar-today-rounded (interop/react-factory CalendarTodayRounded))
(def calendar-today-sharp (interop/react-factory CalendarTodaySharp))
(def calendar-today-two-tone (interop/react-factory CalendarTodayTwoTone))
(def calendar-view-day (interop/react-factory CalendarViewDay))
(def calendar-view-day-outlined (interop/react-factory CalendarViewDayOutlined))
(def calendar-view-day-rounded (interop/react-factory CalendarViewDayRounded))
(def calendar-view-day-sharp (interop/react-factory CalendarViewDaySharp))
(def calendar-view-day-two-tone (interop/react-factory CalendarViewDayTwoTone))
(def call (interop/react-factory Call))
(def call-end (interop/react-factory CallEnd))
(def call-end-outlined (interop/react-factory CallEndOutlined))
(def call-end-rounded (interop/react-factory CallEndRounded))
(def call-end-sharp (interop/react-factory CallEndSharp))
(def call-end-two-tone (interop/react-factory CallEndTwoTone))
(def call-made (interop/react-factory CallMade))
(def call-made-outlined (interop/react-factory CallMadeOutlined))
(def call-made-rounded (interop/react-factory CallMadeRounded))
(def call-made-sharp (interop/react-factory CallMadeSharp))
(def call-made-two-tone (interop/react-factory CallMadeTwoTone))
(def call-merge (interop/react-factory CallMerge))
(def call-merge-outlined (interop/react-factory CallMergeOutlined))
(def call-merge-rounded (interop/react-factory CallMergeRounded))
(def call-merge-sharp (interop/react-factory CallMergeSharp))
(def call-merge-two-tone (interop/react-factory CallMergeTwoTone))
(def call-missed (interop/react-factory CallMissed))
(def call-missed-outgoing (interop/react-factory CallMissedOutgoing))
(def call-missed-outgoing-outlined (interop/react-factory CallMissedOutgoingOutlined))
(def call-missed-outgoing-rounded (interop/react-factory CallMissedOutgoingRounded))
(def call-missed-outgoing-sharp (interop/react-factory CallMissedOutgoingSharp))
(def call-missed-outgoing-two-tone (interop/react-factory CallMissedOutgoingTwoTone))
(def call-missed-outlined (interop/react-factory CallMissedOutlined))
(def call-missed-rounded (interop/react-factory CallMissedRounded))
(def call-missed-sharp (interop/react-factory CallMissedSharp))
(def call-missed-two-tone (interop/react-factory CallMissedTwoTone))
(def call-outlined (interop/react-factory CallOutlined))
(def call-received (interop/react-factory CallReceived))
(def call-received-outlined (interop/react-factory CallReceivedOutlined))
(def call-received-rounded (interop/react-factory CallReceivedRounded))
(def call-received-sharp (interop/react-factory CallReceivedSharp))
(def call-received-two-tone (interop/react-factory CallReceivedTwoTone))
(def call-rounded (interop/react-factory CallRounded))
(def call-sharp (interop/react-factory CallSharp))
(def call-split (interop/react-factory CallSplit))
(def call-split-outlined (interop/react-factory CallSplitOutlined))
(def call-split-rounded (interop/react-factory CallSplitRounded))
(def call-split-sharp (interop/react-factory CallSplitSharp))
(def call-split-two-tone (interop/react-factory CallSplitTwoTone))
(def call-to-action (interop/react-factory CallToAction))
(def call-to-action-outlined (interop/react-factory CallToActionOutlined))
(def call-to-action-rounded (interop/react-factory CallToActionRounded))
(def call-to-action-sharp (interop/react-factory CallToActionSharp))
(def call-to-action-two-tone (interop/react-factory CallToActionTwoTone))
(def call-two-tone (interop/react-factory CallTwoTone))
(def camera (interop/react-factory Camera))
(def camera-alt (interop/react-factory CameraAlt))
(def camera-alt-outlined (interop/react-factory CameraAltOutlined))
(def camera-alt-rounded (interop/react-factory CameraAltRounded))
(def camera-alt-sharp (interop/react-factory CameraAltSharp))
(def camera-alt-two-tone (interop/react-factory CameraAltTwoTone))
(def camera-enhance (interop/react-factory CameraEnhance))
(def camera-enhance-outlined (interop/react-factory CameraEnhanceOutlined))
(def camera-enhance-rounded (interop/react-factory CameraEnhanceRounded))
(def camera-enhance-sharp (interop/react-factory CameraEnhanceSharp))
(def camera-enhance-two-tone (interop/react-factory CameraEnhanceTwoTone))
(def camera-front (interop/react-factory CameraFront))
(def camera-front-outlined (interop/react-factory CameraFrontOutlined))
(def camera-front-rounded (interop/react-factory CameraFrontRounded))
(def camera-front-sharp (interop/react-factory CameraFrontSharp))
(def camera-front-two-tone (interop/react-factory CameraFrontTwoTone))
(def camera-outlined (interop/react-factory CameraOutlined))
(def camera-rear (interop/react-factory CameraRear))
(def camera-rear-outlined (interop/react-factory CameraRearOutlined))
(def camera-rear-rounded (interop/react-factory CameraRearRounded))
(def camera-rear-sharp (interop/react-factory CameraRearSharp))
(def camera-rear-two-tone (interop/react-factory CameraRearTwoTone))
(def camera-roll (interop/react-factory CameraRoll))
(def camera-roll-outlined (interop/react-factory CameraRollOutlined))
(def camera-roll-rounded (interop/react-factory CameraRollRounded))
(def camera-roll-sharp (interop/react-factory CameraRollSharp))
(def camera-roll-two-tone (interop/react-factory CameraRollTwoTone))
(def camera-rounded (interop/react-factory CameraRounded))
(def camera-sharp (interop/react-factory CameraSharp))
(def camera-two-tone (interop/react-factory CameraTwoTone))
(def cancel (interop/react-factory Cancel))
(def cancel-outlined (interop/react-factory CancelOutlined))
(def cancel-presentation (interop/react-factory CancelPresentation))
(def cancel-presentation-outlined (interop/react-factory CancelPresentationOutlined))
(def cancel-presentation-rounded (interop/react-factory CancelPresentationRounded))
(def cancel-presentation-sharp (interop/react-factory CancelPresentationSharp))
(def cancel-presentation-two-tone (interop/react-factory CancelPresentationTwoTone))
(def cancel-rounded (interop/react-factory CancelRounded))
(def cancel-schedule-send (interop/react-factory CancelScheduleSend))
(def cancel-schedule-send-outlined (interop/react-factory CancelScheduleSendOutlined))
(def cancel-schedule-send-rounded (interop/react-factory CancelScheduleSendRounded))
(def cancel-schedule-send-sharp (interop/react-factory CancelScheduleSendSharp))
(def cancel-schedule-send-two-tone (interop/react-factory CancelScheduleSendTwoTone))
(def cancel-sharp (interop/react-factory CancelSharp))
(def cancel-two-tone (interop/react-factory CancelTwoTone))
(def card-giftcard (interop/react-factory CardGiftcard))
(def card-giftcard-outlined (interop/react-factory CardGiftcardOutlined))
(def card-giftcard-rounded (interop/react-factory CardGiftcardRounded))
(def card-giftcard-sharp (interop/react-factory CardGiftcardSharp))
(def card-giftcard-two-tone (interop/react-factory CardGiftcardTwoTone))
(def card-membership (interop/react-factory CardMembership))
(def card-membership-outlined (interop/react-factory CardMembershipOutlined))
(def card-membership-rounded (interop/react-factory CardMembershipRounded))
(def card-membership-sharp (interop/react-factory CardMembershipSharp))
(def card-membership-two-tone (interop/react-factory CardMembershipTwoTone))
(def card-travel (interop/react-factory CardTravel))
(def card-travel-outlined (interop/react-factory CardTravelOutlined))
(def card-travel-rounded (interop/react-factory CardTravelRounded))
(def card-travel-sharp (interop/react-factory CardTravelSharp))
(def card-travel-two-tone (interop/react-factory CardTravelTwoTone))
(def casino (interop/react-factory Casino))
(def casino-outlined (interop/react-factory CasinoOutlined))
(def casino-rounded (interop/react-factory CasinoRounded))
(def casino-sharp (interop/react-factory CasinoSharp))
(def casino-two-tone (interop/react-factory CasinoTwoTone))
(def cast (interop/react-factory Cast))
(def cast-connected (interop/react-factory CastConnected))
(def cast-connected-outlined (interop/react-factory CastConnectedOutlined))
(def cast-connected-rounded (interop/react-factory CastConnectedRounded))
(def cast-connected-sharp (interop/react-factory CastConnectedSharp))
(def cast-connected-two-tone (interop/react-factory CastConnectedTwoTone))
(def cast-for-education (interop/react-factory CastForEducation))
(def cast-for-education-outlined (interop/react-factory CastForEducationOutlined))
(def cast-for-education-rounded (interop/react-factory CastForEducationRounded))
(def cast-for-education-sharp (interop/react-factory CastForEducationSharp))
(def cast-for-education-two-tone (interop/react-factory CastForEducationTwoTone))
(def cast-outlined (interop/react-factory CastOutlined))
(def cast-rounded (interop/react-factory CastRounded))
(def cast-sharp (interop/react-factory CastSharp))
(def cast-two-tone (interop/react-factory CastTwoTone))
(def category (interop/react-factory Category))
(def category-outlined (interop/react-factory CategoryOutlined))
(def category-rounded (interop/react-factory CategoryRounded))
(def category-sharp (interop/react-factory CategorySharp))
(def category-two-tone (interop/react-factory CategoryTwoTone))
(def cell-wifi (interop/react-factory CellWifi))
(def cell-wifi-outlined (interop/react-factory CellWifiOutlined))
(def cell-wifi-rounded (interop/react-factory CellWifiRounded))
(def cell-wifi-sharp (interop/react-factory CellWifiSharp))
(def cell-wifi-two-tone (interop/react-factory CellWifiTwoTone))
(def center-focus-strong (interop/react-factory CenterFocusStrong))
(def center-focus-strong-outlined (interop/react-factory CenterFocusStrongOutlined))
(def center-focus-strong-rounded (interop/react-factory CenterFocusStrongRounded))
(def center-focus-strong-sharp (interop/react-factory CenterFocusStrongSharp))
(def center-focus-strong-two-tone (interop/react-factory CenterFocusStrongTwoTone))
(def center-focus-weak (interop/react-factory CenterFocusWeak))
(def center-focus-weak-outlined (interop/react-factory CenterFocusWeakOutlined))
(def center-focus-weak-rounded (interop/react-factory CenterFocusWeakRounded))
(def center-focus-weak-sharp (interop/react-factory CenterFocusWeakSharp))
(def center-focus-weak-two-tone (interop/react-factory CenterFocusWeakTwoTone))
(def change-history (interop/react-factory ChangeHistory))
(def change-history-outlined (interop/react-factory ChangeHistoryOutlined))
(def change-history-rounded (interop/react-factory ChangeHistoryRounded))
(def change-history-sharp (interop/react-factory ChangeHistorySharp))
(def change-history-two-tone (interop/react-factory ChangeHistoryTwoTone))
(def chat (interop/react-factory Chat))
(def chat-bubble (interop/react-factory ChatBubble))
(def chat-bubble-outline (interop/react-factory ChatBubbleOutline))
(def chat-bubble-outlined (interop/react-factory ChatBubbleOutlined))
(def chat-bubble-outline-outlined (interop/react-factory ChatBubbleOutlineOutlined))
(def chat-bubble-outline-rounded (interop/react-factory ChatBubbleOutlineRounded))
(def chat-bubble-outline-sharp (interop/react-factory ChatBubbleOutlineSharp))
(def chat-bubble-outline-two-tone (interop/react-factory ChatBubbleOutlineTwoTone))
(def chat-bubble-rounded (interop/react-factory ChatBubbleRounded))
(def chat-bubble-sharp (interop/react-factory ChatBubbleSharp))
(def chat-bubble-two-tone (interop/react-factory ChatBubbleTwoTone))
(def chat-outlined (interop/react-factory ChatOutlined))
(def chat-rounded (interop/react-factory ChatRounded))
(def chat-sharp (interop/react-factory ChatSharp))
(def chat-two-tone (interop/react-factory ChatTwoTone))
(def check (interop/react-factory Check))
(def check-box (interop/react-factory CheckBox))
(def check-box-outline-blank (interop/react-factory CheckBoxOutlineBlank))
(def check-box-outline-blank-outlined (interop/react-factory CheckBoxOutlineBlankOutlined))
(def check-box-outline-blank-rounded (interop/react-factory CheckBoxOutlineBlankRounded))
(def check-box-outline-blank-sharp (interop/react-factory CheckBoxOutlineBlankSharp))
(def check-box-outline-blank-two-tone (interop/react-factory CheckBoxOutlineBlankTwoTone))
(def check-box-outlined (interop/react-factory CheckBoxOutlined))
(def check-box-rounded (interop/react-factory CheckBoxRounded))
(def check-box-sharp (interop/react-factory CheckBoxSharp))
(def check-box-two-tone (interop/react-factory CheckBoxTwoTone))
(def check-circle (interop/react-factory CheckCircle))
(def check-circle-outline (interop/react-factory CheckCircleOutline))
(def check-circle-outlined (interop/react-factory CheckCircleOutlined))
(def check-circle-outline-outlined (interop/react-factory CheckCircleOutlineOutlined))
(def check-circle-outline-rounded (interop/react-factory CheckCircleOutlineRounded))
(def check-circle-outline-sharp (interop/react-factory CheckCircleOutlineSharp))
(def check-circle-outline-two-tone (interop/react-factory CheckCircleOutlineTwoTone))
(def check-circle-rounded (interop/react-factory CheckCircleRounded))
(def check-circle-sharp (interop/react-factory CheckCircleSharp))
(def check-circle-two-tone (interop/react-factory CheckCircleTwoTone))
(def check-outlined (interop/react-factory CheckOutlined))
(def check-rounded (interop/react-factory CheckRounded))
(def check-sharp (interop/react-factory CheckSharp))
(def check-two-tone (interop/react-factory CheckTwoTone))
(def chevron-left (interop/react-factory ChevronLeft))
(def chevron-left-outlined (interop/react-factory ChevronLeftOutlined))
(def chevron-left-rounded (interop/react-factory ChevronLeftRounded))
(def chevron-left-sharp (interop/react-factory ChevronLeftSharp))
(def chevron-left-two-tone (interop/react-factory ChevronLeftTwoTone))
(def chevron-right (interop/react-factory ChevronRight))
(def chevron-right-outlined (interop/react-factory ChevronRightOutlined))
(def chevron-right-rounded (interop/react-factory ChevronRightRounded))
(def chevron-right-sharp (interop/react-factory ChevronRightSharp))
(def chevron-right-two-tone (interop/react-factory ChevronRightTwoTone))
(def child-care (interop/react-factory ChildCare))
(def child-care-outlined (interop/react-factory ChildCareOutlined))
(def child-care-rounded (interop/react-factory ChildCareRounded))
(def child-care-sharp (interop/react-factory ChildCareSharp))
(def child-care-two-tone (interop/react-factory ChildCareTwoTone))
(def child-friendly (interop/react-factory ChildFriendly))
(def child-friendly-outlined (interop/react-factory ChildFriendlyOutlined))
(def child-friendly-rounded (interop/react-factory ChildFriendlyRounded))
(def child-friendly-sharp (interop/react-factory ChildFriendlySharp))
(def child-friendly-two-tone (interop/react-factory ChildFriendlyTwoTone))
(def chrome-reader-mode (interop/react-factory ChromeReaderMode))
(def chrome-reader-mode-outlined (interop/react-factory ChromeReaderModeOutlined))
(def chrome-reader-mode-rounded (interop/react-factory ChromeReaderModeRounded))
(def chrome-reader-mode-sharp (interop/react-factory ChromeReaderModeSharp))
(def chrome-reader-mode-two-tone (interop/react-factory ChromeReaderModeTwoTone))
(def class (interop/react-factory Class))
(def class-outlined (interop/react-factory ClassOutlined))
(def class-rounded (interop/react-factory ClassRounded))
(def class-sharp (interop/react-factory ClassSharp))
(def class-two-tone (interop/react-factory ClassTwoTone))
(def clear (interop/react-factory Clear))
(def clear-all (interop/react-factory ClearAll))
(def clear-all-outlined (interop/react-factory ClearAllOutlined))
(def clear-all-rounded (interop/react-factory ClearAllRounded))
(def clear-all-sharp (interop/react-factory ClearAllSharp))
(def clear-all-two-tone (interop/react-factory ClearAllTwoTone))
(def clear-outlined (interop/react-factory ClearOutlined))
(def clear-rounded (interop/react-factory ClearRounded))
(def clear-sharp (interop/react-factory ClearSharp))
(def clear-two-tone (interop/react-factory ClearTwoTone))
(def close (interop/react-factory Close))
(def closed-caption (interop/react-factory ClosedCaption))
(def closed-caption-outlined (interop/react-factory ClosedCaptionOutlined))
(def closed-caption-rounded (interop/react-factory ClosedCaptionRounded))
(def closed-caption-sharp (interop/react-factory ClosedCaptionSharp))
(def closed-caption-two-tone (interop/react-factory ClosedCaptionTwoTone))
(def close-outlined (interop/react-factory CloseOutlined))
(def close-rounded (interop/react-factory CloseRounded))
(def close-sharp (interop/react-factory CloseSharp))
(def close-two-tone (interop/react-factory CloseTwoTone))
(def cloud (interop/react-factory Cloud))
(def cloud-circle (interop/react-factory CloudCircle))
(def cloud-circle-outlined (interop/react-factory CloudCircleOutlined))
(def cloud-circle-rounded (interop/react-factory CloudCircleRounded))
(def cloud-circle-sharp (interop/react-factory CloudCircleSharp))
(def cloud-circle-two-tone (interop/react-factory CloudCircleTwoTone))
(def cloud-done (interop/react-factory CloudDone))
(def cloud-done-outlined (interop/react-factory CloudDoneOutlined))
(def cloud-done-rounded (interop/react-factory CloudDoneRounded))
(def cloud-done-sharp (interop/react-factory CloudDoneSharp))
(def cloud-done-two-tone (interop/react-factory CloudDoneTwoTone))
(def cloud-download (interop/react-factory CloudDownload))
(def cloud-download-outlined (interop/react-factory CloudDownloadOutlined))
(def cloud-download-rounded (interop/react-factory CloudDownloadRounded))
(def cloud-download-sharp (interop/react-factory CloudDownloadSharp))
(def cloud-download-two-tone (interop/react-factory CloudDownloadTwoTone))
(def cloud-off (interop/react-factory CloudOff))
(def cloud-off-outlined (interop/react-factory CloudOffOutlined))
(def cloud-off-rounded (interop/react-factory CloudOffRounded))
(def cloud-off-sharp (interop/react-factory CloudOffSharp))
(def cloud-off-two-tone (interop/react-factory CloudOffTwoTone))
(def cloud-outlined (interop/react-factory CloudOutlined))
(def cloud-queue (interop/react-factory CloudQueue))
(def cloud-queue-outlined (interop/react-factory CloudQueueOutlined))
(def cloud-queue-rounded (interop/react-factory CloudQueueRounded))
(def cloud-queue-sharp (interop/react-factory CloudQueueSharp))
(def cloud-queue-two-tone (interop/react-factory CloudQueueTwoTone))
(def cloud-rounded (interop/react-factory CloudRounded))
(def cloud-sharp (interop/react-factory CloudSharp))
(def cloud-two-tone (interop/react-factory CloudTwoTone))
(def cloud-upload (interop/react-factory CloudUpload))
(def cloud-upload-outlined (interop/react-factory CloudUploadOutlined))
(def cloud-upload-rounded (interop/react-factory CloudUploadRounded))
(def cloud-upload-sharp (interop/react-factory CloudUploadSharp))
(def cloud-upload-two-tone (interop/react-factory CloudUploadTwoTone))
(def code (interop/react-factory Code))
(def code-outlined (interop/react-factory CodeOutlined))
(def code-rounded (interop/react-factory CodeRounded))
(def code-sharp (interop/react-factory CodeSharp))
(def code-two-tone (interop/react-factory CodeTwoTone))
(def collections (interop/react-factory Collections))
(def collections-bookmark (interop/react-factory CollectionsBookmark))
(def collections-bookmark-outlined (interop/react-factory CollectionsBookmarkOutlined))
(def collections-bookmark-rounded (interop/react-factory CollectionsBookmarkRounded))
(def collections-bookmark-sharp (interop/react-factory CollectionsBookmarkSharp))
(def collections-bookmark-two-tone (interop/react-factory CollectionsBookmarkTwoTone))
(def collections-outlined (interop/react-factory CollectionsOutlined))
(def collections-rounded (interop/react-factory CollectionsRounded))
(def collections-sharp (interop/react-factory CollectionsSharp))
(def collections-two-tone (interop/react-factory CollectionsTwoTone))
(def colorize (interop/react-factory Colorize))
(def colorize-outlined (interop/react-factory ColorizeOutlined))
(def colorize-rounded (interop/react-factory ColorizeRounded))
(def colorize-sharp (interop/react-factory ColorizeSharp))
(def colorize-two-tone (interop/react-factory ColorizeTwoTone))
(def color-lens (interop/react-factory ColorLens))
(def color-lens-outlined (interop/react-factory ColorLensOutlined))
(def color-lens-rounded (interop/react-factory ColorLensRounded))
(def color-lens-sharp (interop/react-factory ColorLensSharp))
(def color-lens-two-tone (interop/react-factory ColorLensTwoTone))
(def comment (interop/react-factory Comment))
(def comment-outlined (interop/react-factory CommentOutlined))
(def comment-rounded (interop/react-factory CommentRounded))
(def comment-sharp (interop/react-factory CommentSharp))
(def comment-two-tone (interop/react-factory CommentTwoTone))
(def commute (interop/react-factory Commute))
(def commute-outlined (interop/react-factory CommuteOutlined))
(def commute-rounded (interop/react-factory CommuteRounded))
(def commute-sharp (interop/react-factory CommuteSharp))
(def commute-two-tone (interop/react-factory CommuteTwoTone))
(def compare (interop/react-factory Compare))
(def compare-arrows (interop/react-factory CompareArrows))
(def compare-arrows-outlined (interop/react-factory CompareArrowsOutlined))
(def compare-arrows-rounded (interop/react-factory CompareArrowsRounded))
(def compare-arrows-sharp (interop/react-factory CompareArrowsSharp))
(def compare-arrows-two-tone (interop/react-factory CompareArrowsTwoTone))
(def compare-outlined (interop/react-factory CompareOutlined))
(def compare-rounded (interop/react-factory CompareRounded))
(def compare-sharp (interop/react-factory CompareSharp))
(def compare-two-tone (interop/react-factory CompareTwoTone))
(def compass-calibration (interop/react-factory CompassCalibration))
(def compass-calibration-outlined (interop/react-factory CompassCalibrationOutlined))
(def compass-calibration-rounded (interop/react-factory CompassCalibrationRounded))
(def compass-calibration-sharp (interop/react-factory CompassCalibrationSharp))
(def compass-calibration-two-tone (interop/react-factory CompassCalibrationTwoTone))
(def computer (interop/react-factory Computer))
(def computer-outlined (interop/react-factory ComputerOutlined))
(def computer-rounded (interop/react-factory ComputerRounded))
(def computer-sharp (interop/react-factory ComputerSharp))
(def computer-two-tone (interop/react-factory ComputerTwoTone))
(def confirmation-number (interop/react-factory ConfirmationNumber))
(def confirmation-number-outlined (interop/react-factory ConfirmationNumberOutlined))
(def confirmation-number-rounded (interop/react-factory ConfirmationNumberRounded))
(def confirmation-number-sharp (interop/react-factory ConfirmationNumberSharp))
(def confirmation-number-two-tone (interop/react-factory ConfirmationNumberTwoTone))
(def contactless (interop/react-factory Contactless))
(def contactless-outlined (interop/react-factory ContactlessOutlined))
(def contactless-rounded (interop/react-factory ContactlessRounded))
(def contactless-sharp (interop/react-factory ContactlessSharp))
(def contactless-two-tone (interop/react-factory ContactlessTwoTone))
(def contact-mail (interop/react-factory ContactMail))
(def contact-mail-outlined (interop/react-factory ContactMailOutlined))
(def contact-mail-rounded (interop/react-factory ContactMailRounded))
(def contact-mail-sharp (interop/react-factory ContactMailSharp))
(def contact-mail-two-tone (interop/react-factory ContactMailTwoTone))
(def contact-phone (interop/react-factory ContactPhone))
(def contact-phone-outlined (interop/react-factory ContactPhoneOutlined))
(def contact-phone-rounded (interop/react-factory ContactPhoneRounded))
(def contact-phone-sharp (interop/react-factory ContactPhoneSharp))
(def contact-phone-two-tone (interop/react-factory ContactPhoneTwoTone))
(def contacts (interop/react-factory Contacts))
(def contacts-outlined (interop/react-factory ContactsOutlined))
(def contacts-rounded (interop/react-factory ContactsRounded))
(def contacts-sharp (interop/react-factory ContactsSharp))
(def contacts-two-tone (interop/react-factory ContactsTwoTone))
(def contact-support (interop/react-factory ContactSupport))
(def contact-support-outlined (interop/react-factory ContactSupportOutlined))
(def contact-support-rounded (interop/react-factory ContactSupportRounded))
(def contact-support-sharp (interop/react-factory ContactSupportSharp))
(def contact-support-two-tone (interop/react-factory ContactSupportTwoTone))
(def control-camera (interop/react-factory ControlCamera))
(def control-camera-outlined (interop/react-factory ControlCameraOutlined))
(def control-camera-rounded (interop/react-factory ControlCameraRounded))
(def control-camera-sharp (interop/react-factory ControlCameraSharp))
(def control-camera-two-tone (interop/react-factory ControlCameraTwoTone))
(def control-point (interop/react-factory ControlPoint))
(def control-point-duplicate (interop/react-factory ControlPointDuplicate))
(def control-point-duplicate-outlined (interop/react-factory ControlPointDuplicateOutlined))
(def control-point-duplicate-rounded (interop/react-factory ControlPointDuplicateRounded))
(def control-point-duplicate-sharp (interop/react-factory ControlPointDuplicateSharp))
(def control-point-duplicate-two-tone (interop/react-factory ControlPointDuplicateTwoTone))
(def control-point-outlined (interop/react-factory ControlPointOutlined))
(def control-point-rounded (interop/react-factory ControlPointRounded))
(def control-point-sharp (interop/react-factory ControlPointSharp))
(def control-point-two-tone (interop/react-factory ControlPointTwoTone))
(def copyright (interop/react-factory Copyright))
(def copyright-outlined (interop/react-factory CopyrightOutlined))
(def copyright-rounded (interop/react-factory CopyrightRounded))
(def copyright-sharp (interop/react-factory CopyrightSharp))
(def copyright-two-tone (interop/react-factory CopyrightTwoTone))
(def create (interop/react-factory Create))
(def create-new-folder (interop/react-factory CreateNewFolder))
(def create-new-folder-outlined (interop/react-factory CreateNewFolderOutlined))
(def create-new-folder-rounded (interop/react-factory CreateNewFolderRounded))
(def create-new-folder-sharp (interop/react-factory CreateNewFolderSharp))
(def create-new-folder-two-tone (interop/react-factory CreateNewFolderTwoTone))
(def create-outlined (interop/react-factory CreateOutlined))
(def create-rounded (interop/react-factory CreateRounded))
(def create-sharp (interop/react-factory CreateSharp))
(def create-two-tone (interop/react-factory CreateTwoTone))
(def credit-card (interop/react-factory CreditCard))
(def credit-card-outlined (interop/react-factory CreditCardOutlined))
(def credit-card-rounded (interop/react-factory CreditCardRounded))
(def credit-card-sharp (interop/react-factory CreditCardSharp))
(def credit-card-two-tone (interop/react-factory CreditCardTwoTone))
(def crop (interop/react-factory Crop))
(def crop169 (interop/react-factory Crop169))
(def crop169-outlined (interop/react-factory Crop169Outlined))
(def crop169-rounded (interop/react-factory Crop169Rounded))
(def crop169-sharp (interop/react-factory Crop169Sharp))
(def crop169-two-tone (interop/react-factory Crop169TwoTone))
(def crop32 (interop/react-factory Crop32))
(def crop32-outlined (interop/react-factory Crop32Outlined))
(def crop32-rounded (interop/react-factory Crop32Rounded))
(def crop32-sharp (interop/react-factory Crop32Sharp))
(def crop32-two-tone (interop/react-factory Crop32TwoTone))
(def crop54 (interop/react-factory Crop54))
(def crop54-outlined (interop/react-factory Crop54Outlined))
(def crop54-rounded (interop/react-factory Crop54Rounded))
(def crop54-sharp (interop/react-factory Crop54Sharp))
(def crop54-two-tone (interop/react-factory Crop54TwoTone))
(def crop75 (interop/react-factory Crop75))
(def crop75-outlined (interop/react-factory Crop75Outlined))
(def crop75-rounded (interop/react-factory Crop75Rounded))
(def crop75-sharp (interop/react-factory Crop75Sharp))
(def crop75-two-tone (interop/react-factory Crop75TwoTone))
(def crop-din (interop/react-factory CropDin))
(def crop-din-outlined (interop/react-factory CropDinOutlined))
(def crop-din-rounded (interop/react-factory CropDinRounded))
(def crop-din-sharp (interop/react-factory CropDinSharp))
(def crop-din-two-tone (interop/react-factory CropDinTwoTone))
(def crop-free (interop/react-factory CropFree))
(def crop-free-outlined (interop/react-factory CropFreeOutlined))
(def crop-free-rounded (interop/react-factory CropFreeRounded))
(def crop-free-sharp (interop/react-factory CropFreeSharp))
(def crop-free-two-tone (interop/react-factory CropFreeTwoTone))
(def crop-landscape (interop/react-factory CropLandscape))
(def crop-landscape-outlined (interop/react-factory CropLandscapeOutlined))
(def crop-landscape-rounded (interop/react-factory CropLandscapeRounded))
(def crop-landscape-sharp (interop/react-factory CropLandscapeSharp))
(def crop-landscape-two-tone (interop/react-factory CropLandscapeTwoTone))
(def crop-original (interop/react-factory CropOriginal))
(def crop-original-outlined (interop/react-factory CropOriginalOutlined))
(def crop-original-rounded (interop/react-factory CropOriginalRounded))
(def crop-original-sharp (interop/react-factory CropOriginalSharp))
(def crop-original-two-tone (interop/react-factory CropOriginalTwoTone))
(def crop-outlined (interop/react-factory CropOutlined))
(def crop-portrait (interop/react-factory CropPortrait))
(def crop-portrait-outlined (interop/react-factory CropPortraitOutlined))
(def crop-portrait-rounded (interop/react-factory CropPortraitRounded))
(def crop-portrait-sharp (interop/react-factory CropPortraitSharp))
(def crop-portrait-two-tone (interop/react-factory CropPortraitTwoTone))
(def crop-rotate (interop/react-factory CropRotate))
(def crop-rotate-outlined (interop/react-factory CropRotateOutlined))
(def crop-rotate-rounded (interop/react-factory CropRotateRounded))
(def crop-rotate-sharp (interop/react-factory CropRotateSharp))
(def crop-rotate-two-tone (interop/react-factory CropRotateTwoTone))
(def crop-rounded (interop/react-factory CropRounded))
(def crop-sharp (interop/react-factory CropSharp))
(def crop-square (interop/react-factory CropSquare))
(def crop-square-outlined (interop/react-factory CropSquareOutlined))
(def crop-square-rounded (interop/react-factory CropSquareRounded))
(def crop-square-sharp (interop/react-factory CropSquareSharp))
(def crop-square-two-tone (interop/react-factory CropSquareTwoTone))
(def crop-two-tone (interop/react-factory CropTwoTone))
(def dashboard (interop/react-factory Dashboard))
(def dashboard-outlined (interop/react-factory DashboardOutlined))
(def dashboard-rounded (interop/react-factory DashboardRounded))
(def dashboard-sharp (interop/react-factory DashboardSharp))
(def dashboard-two-tone (interop/react-factory DashboardTwoTone))
(def data-usage (interop/react-factory DataUsage))
(def data-usage-outlined (interop/react-factory DataUsageOutlined))
(def data-usage-rounded (interop/react-factory DataUsageRounded))
(def data-usage-sharp (interop/react-factory DataUsageSharp))
(def data-usage-two-tone (interop/react-factory DataUsageTwoTone))
(def date-range (interop/react-factory DateRange))
(def date-range-outlined (interop/react-factory DateRangeOutlined))
(def date-range-rounded (interop/react-factory DateRangeRounded))
(def date-range-sharp (interop/react-factory DateRangeSharp))
(def date-range-two-tone (interop/react-factory DateRangeTwoTone))
(def deck (interop/react-factory Deck))
(def deck-outlined (interop/react-factory DeckOutlined))
(def deck-rounded (interop/react-factory DeckRounded))
(def deck-sharp (interop/react-factory DeckSharp))
(def deck-two-tone (interop/react-factory DeckTwoTone))
(def dehaze (interop/react-factory Dehaze))
(def dehaze-outlined (interop/react-factory DehazeOutlined))
(def dehaze-rounded (interop/react-factory DehazeRounded))
(def dehaze-sharp (interop/react-factory DehazeSharp))
(def dehaze-two-tone (interop/react-factory DehazeTwoTone))
(def delete (interop/react-factory Delete))
(def delete-forever (interop/react-factory DeleteForever))
(def delete-forever-outlined (interop/react-factory DeleteForeverOutlined))
(def delete-forever-rounded (interop/react-factory DeleteForeverRounded))
(def delete-forever-sharp (interop/react-factory DeleteForeverSharp))
(def delete-forever-two-tone (interop/react-factory DeleteForeverTwoTone))
(def delete-outline (interop/react-factory DeleteOutline))
(def delete-outlined (interop/react-factory DeleteOutlined))
(def delete-outline-outlined (interop/react-factory DeleteOutlineOutlined))
(def delete-outline-rounded (interop/react-factory DeleteOutlineRounded))
(def delete-outline-sharp (interop/react-factory DeleteOutlineSharp))
(def delete-outline-two-tone (interop/react-factory DeleteOutlineTwoTone))
(def delete-rounded (interop/react-factory DeleteRounded))
(def delete-sharp (interop/react-factory DeleteSharp))
(def delete-sweep (interop/react-factory DeleteSweep))
(def delete-sweep-outlined (interop/react-factory DeleteSweepOutlined))
(def delete-sweep-rounded (interop/react-factory DeleteSweepRounded))
(def delete-sweep-sharp (interop/react-factory DeleteSweepSharp))
(def delete-sweep-two-tone (interop/react-factory DeleteSweepTwoTone))
(def delete-two-tone (interop/react-factory DeleteTwoTone))
(def departure-board (interop/react-factory DepartureBoard))
(def departure-board-outlined (interop/react-factory DepartureBoardOutlined))
(def departure-board-rounded (interop/react-factory DepartureBoardRounded))
(def departure-board-sharp (interop/react-factory DepartureBoardSharp))
(def departure-board-two-tone (interop/react-factory DepartureBoardTwoTone))
(def description (interop/react-factory Description))
(def description-outlined (interop/react-factory DescriptionOutlined))
(def description-rounded (interop/react-factory DescriptionRounded))
(def description-sharp (interop/react-factory DescriptionSharp))
(def description-two-tone (interop/react-factory DescriptionTwoTone))
(def desktop-access-disabled (interop/react-factory DesktopAccessDisabled))
(def desktop-access-disabled-outlined (interop/react-factory DesktopAccessDisabledOutlined))
(def desktop-access-disabled-rounded (interop/react-factory DesktopAccessDisabledRounded))
(def desktop-access-disabled-sharp (interop/react-factory DesktopAccessDisabledSharp))
(def desktop-access-disabled-two-tone (interop/react-factory DesktopAccessDisabledTwoTone))
(def desktop-mac (interop/react-factory DesktopMac))
(def desktop-mac-outlined (interop/react-factory DesktopMacOutlined))
(def desktop-mac-rounded (interop/react-factory DesktopMacRounded))
(def desktop-mac-sharp (interop/react-factory DesktopMacSharp))
(def desktop-mac-two-tone (interop/react-factory DesktopMacTwoTone))
(def desktop-windows (interop/react-factory DesktopWindows))
(def desktop-windows-outlined (interop/react-factory DesktopWindowsOutlined))
(def desktop-windows-rounded (interop/react-factory DesktopWindowsRounded))
(def desktop-windows-sharp (interop/react-factory DesktopWindowsSharp))
(def desktop-windows-two-tone (interop/react-factory DesktopWindowsTwoTone))
(def details (interop/react-factory Details))
(def details-outlined (interop/react-factory DetailsOutlined))
(def details-rounded (interop/react-factory DetailsRounded))
(def details-sharp (interop/react-factory DetailsSharp))
(def details-two-tone (interop/react-factory DetailsTwoTone))
(def developer-board (interop/react-factory DeveloperBoard))
(def developer-board-outlined (interop/react-factory DeveloperBoardOutlined))
(def developer-board-rounded (interop/react-factory DeveloperBoardRounded))
(def developer-board-sharp (interop/react-factory DeveloperBoardSharp))
(def developer-board-two-tone (interop/react-factory DeveloperBoardTwoTone))
(def developer-mode (interop/react-factory DeveloperMode))
(def developer-mode-outlined (interop/react-factory DeveloperModeOutlined))
(def developer-mode-rounded (interop/react-factory DeveloperModeRounded))
(def developer-mode-sharp (interop/react-factory DeveloperModeSharp))
(def developer-mode-two-tone (interop/react-factory DeveloperModeTwoTone))
(def device-hub (interop/react-factory DeviceHub))
(def device-hub-outlined (interop/react-factory DeviceHubOutlined))
(def device-hub-rounded (interop/react-factory DeviceHubRounded))
(def device-hub-sharp (interop/react-factory DeviceHubSharp))
(def device-hub-two-tone (interop/react-factory DeviceHubTwoTone))
(def devices (interop/react-factory Devices))
(def devices-other (interop/react-factory DevicesOther))
(def devices-other-outlined (interop/react-factory DevicesOtherOutlined))
(def devices-other-rounded (interop/react-factory DevicesOtherRounded))
(def devices-other-sharp (interop/react-factory DevicesOtherSharp))
(def devices-other-two-tone (interop/react-factory DevicesOtherTwoTone))
(def devices-outlined (interop/react-factory DevicesOutlined))
(def devices-rounded (interop/react-factory DevicesRounded))
(def devices-sharp (interop/react-factory DevicesSharp))
(def devices-two-tone (interop/react-factory DevicesTwoTone))
(def device-unknown (interop/react-factory DeviceUnknown))
(def device-unknown-outlined (interop/react-factory DeviceUnknownOutlined))
(def device-unknown-rounded (interop/react-factory DeviceUnknownRounded))
(def device-unknown-sharp (interop/react-factory DeviceUnknownSharp))
(def device-unknown-two-tone (interop/react-factory DeviceUnknownTwoTone))
(def dialer-sip (interop/react-factory DialerSip))
(def dialer-sip-outlined (interop/react-factory DialerSipOutlined))
(def dialer-sip-rounded (interop/react-factory DialerSipRounded))
(def dialer-sip-sharp (interop/react-factory DialerSipSharp))
(def dialer-sip-two-tone (interop/react-factory DialerSipTwoTone))
(def dialpad (interop/react-factory Dialpad))
(def dialpad-outlined (interop/react-factory DialpadOutlined))
(def dialpad-rounded (interop/react-factory DialpadRounded))
(def dialpad-sharp (interop/react-factory DialpadSharp))
(def dialpad-two-tone (interop/react-factory DialpadTwoTone))
(def directions (interop/react-factory Directions))
(def directions-bike (interop/react-factory DirectionsBike))
(def directions-bike-outlined (interop/react-factory DirectionsBikeOutlined))
(def directions-bike-rounded (interop/react-factory DirectionsBikeRounded))
(def directions-bike-sharp (interop/react-factory DirectionsBikeSharp))
(def directions-bike-two-tone (interop/react-factory DirectionsBikeTwoTone))
(def directions-boat (interop/react-factory DirectionsBoat))
(def directions-boat-outlined (interop/react-factory DirectionsBoatOutlined))
(def directions-boat-rounded (interop/react-factory DirectionsBoatRounded))
(def directions-boat-sharp (interop/react-factory DirectionsBoatSharp))
(def directions-boat-two-tone (interop/react-factory DirectionsBoatTwoTone))
(def directions-bus (interop/react-factory DirectionsBus))
(def directions-bus-outlined (interop/react-factory DirectionsBusOutlined))
(def directions-bus-rounded (interop/react-factory DirectionsBusRounded))
(def directions-bus-sharp (interop/react-factory DirectionsBusSharp))
(def directions-bus-two-tone (interop/react-factory DirectionsBusTwoTone))
(def directions-car (interop/react-factory DirectionsCar))
(def directions-car-outlined (interop/react-factory DirectionsCarOutlined))
(def directions-car-rounded (interop/react-factory DirectionsCarRounded))
(def directions-car-sharp (interop/react-factory DirectionsCarSharp))
(def directions-car-two-tone (interop/react-factory DirectionsCarTwoTone))
(def directions-outlined (interop/react-factory DirectionsOutlined))
(def directions-railway (interop/react-factory DirectionsRailway))
(def directions-railway-outlined (interop/react-factory DirectionsRailwayOutlined))
(def directions-railway-rounded (interop/react-factory DirectionsRailwayRounded))
(def directions-railway-sharp (interop/react-factory DirectionsRailwaySharp))
(def directions-railway-two-tone (interop/react-factory DirectionsRailwayTwoTone))
(def directions-rounded (interop/react-factory DirectionsRounded))
(def directions-run (interop/react-factory DirectionsRun))
(def directions-run-outlined (interop/react-factory DirectionsRunOutlined))
(def directions-run-rounded (interop/react-factory DirectionsRunRounded))
(def directions-run-sharp (interop/react-factory DirectionsRunSharp))
(def directions-run-two-tone (interop/react-factory DirectionsRunTwoTone))
(def directions-sharp (interop/react-factory DirectionsSharp))
(def directions-subway (interop/react-factory DirectionsSubway))
(def directions-subway-outlined (interop/react-factory DirectionsSubwayOutlined))
(def directions-subway-rounded (interop/react-factory DirectionsSubwayRounded))
(def directions-subway-sharp (interop/react-factory DirectionsSubwaySharp))
(def directions-subway-two-tone (interop/react-factory DirectionsSubwayTwoTone))
(def directions-transit (interop/react-factory DirectionsTransit))
(def directions-transit-outlined (interop/react-factory DirectionsTransitOutlined))
(def directions-transit-rounded (interop/react-factory DirectionsTransitRounded))
(def directions-transit-sharp (interop/react-factory DirectionsTransitSharp))
(def directions-transit-two-tone (interop/react-factory DirectionsTransitTwoTone))
(def directions-two-tone (interop/react-factory DirectionsTwoTone))
(def directions-walk (interop/react-factory DirectionsWalk))
(def directions-walk-outlined (interop/react-factory DirectionsWalkOutlined))
(def directions-walk-rounded (interop/react-factory DirectionsWalkRounded))
(def directions-walk-sharp (interop/react-factory DirectionsWalkSharp))
(def directions-walk-two-tone (interop/react-factory DirectionsWalkTwoTone))
(def disc-full (interop/react-factory DiscFull))
(def disc-full-outlined (interop/react-factory DiscFullOutlined))
(def disc-full-rounded (interop/react-factory DiscFullRounded))
(def disc-full-sharp (interop/react-factory DiscFullSharp))
(def disc-full-two-tone (interop/react-factory DiscFullTwoTone))
(def dns (interop/react-factory Dns))
(def dns-outlined (interop/react-factory DnsOutlined))
(def dns-rounded (interop/react-factory DnsRounded))
(def dns-sharp (interop/react-factory DnsSharp))
(def dns-two-tone (interop/react-factory DnsTwoTone))
(def dock (interop/react-factory Dock))
(def dock-outlined (interop/react-factory DockOutlined))
(def dock-rounded (interop/react-factory DockRounded))
(def dock-sharp (interop/react-factory DockSharp))
(def dock-two-tone (interop/react-factory DockTwoTone))
(def domain (interop/react-factory Domain))
(def domain-disabled (interop/react-factory DomainDisabled))
(def domain-disabled-outlined (interop/react-factory DomainDisabledOutlined))
(def domain-disabled-rounded (interop/react-factory DomainDisabledRounded))
(def domain-disabled-sharp (interop/react-factory DomainDisabledSharp))
(def domain-disabled-two-tone (interop/react-factory DomainDisabledTwoTone))
(def domain-outlined (interop/react-factory DomainOutlined))
(def domain-rounded (interop/react-factory DomainRounded))
(def domain-sharp (interop/react-factory DomainSharp))
(def domain-two-tone (interop/react-factory DomainTwoTone))
(def done (interop/react-factory Done))
(def done-all (interop/react-factory DoneAll))
(def done-all-outlined (interop/react-factory DoneAllOutlined))
(def done-all-rounded (interop/react-factory DoneAllRounded))
(def done-all-sharp (interop/react-factory DoneAllSharp))
(def done-all-two-tone (interop/react-factory DoneAllTwoTone))
(def done-outline (interop/react-factory DoneOutline))
(def done-outlined (interop/react-factory DoneOutlined))
(def done-outline-outlined (interop/react-factory DoneOutlineOutlined))
(def done-outline-rounded (interop/react-factory DoneOutlineRounded))
(def done-outline-sharp (interop/react-factory DoneOutlineSharp))
(def done-outline-two-tone (interop/react-factory DoneOutlineTwoTone))
(def done-rounded (interop/react-factory DoneRounded))
(def done-sharp (interop/react-factory DoneSharp))
(def done-two-tone (interop/react-factory DoneTwoTone))
(def donut-large (interop/react-factory DonutLarge))
(def donut-large-outlined (interop/react-factory DonutLargeOutlined))
(def donut-large-rounded (interop/react-factory DonutLargeRounded))
(def donut-large-sharp (interop/react-factory DonutLargeSharp))
(def donut-large-two-tone (interop/react-factory DonutLargeTwoTone))
(def donut-small (interop/react-factory DonutSmall))
(def donut-small-outlined (interop/react-factory DonutSmallOutlined))
(def donut-small-rounded (interop/react-factory DonutSmallRounded))
(def donut-small-sharp (interop/react-factory DonutSmallSharp))
(def donut-small-two-tone (interop/react-factory DonutSmallTwoTone))
(def double-arrow (interop/react-factory DoubleArrow))
(def double-arrow-outlined (interop/react-factory DoubleArrowOutlined))
(def double-arrow-rounded (interop/react-factory DoubleArrowRounded))
(def double-arrow-sharp (interop/react-factory DoubleArrowSharp))
(def double-arrow-two-tone (interop/react-factory DoubleArrowTwoTone))
(def drafts (interop/react-factory Drafts))
(def drafts-outlined (interop/react-factory DraftsOutlined))
(def drafts-rounded (interop/react-factory DraftsRounded))
(def drafts-sharp (interop/react-factory DraftsSharp))
(def drafts-two-tone (interop/react-factory DraftsTwoTone))
(def drag-handle (interop/react-factory DragHandle))
(def drag-handle-outlined (interop/react-factory DragHandleOutlined))
(def drag-handle-rounded (interop/react-factory DragHandleRounded))
(def drag-handle-sharp (interop/react-factory DragHandleSharp))
(def drag-handle-two-tone (interop/react-factory DragHandleTwoTone))
(def drag-indicator (interop/react-factory DragIndicator))
(def drag-indicator-outlined (interop/react-factory DragIndicatorOutlined))
(def drag-indicator-rounded (interop/react-factory DragIndicatorRounded))
(def drag-indicator-sharp (interop/react-factory DragIndicatorSharp))
(def drag-indicator-two-tone (interop/react-factory DragIndicatorTwoTone))
(def drive-eta (interop/react-factory DriveEta))
(def drive-eta-outlined (interop/react-factory DriveEtaOutlined))
(def drive-eta-rounded (interop/react-factory DriveEtaRounded))
(def drive-eta-sharp (interop/react-factory DriveEtaSharp))
(def drive-eta-two-tone (interop/react-factory DriveEtaTwoTone))
(def duo (interop/react-factory Duo))
(def duo-outlined (interop/react-factory DuoOutlined))
(def duo-rounded (interop/react-factory DuoRounded))
(def duo-sharp (interop/react-factory DuoSharp))
(def duo-two-tone (interop/react-factory DuoTwoTone))
(def dvr (interop/react-factory Dvr))
(def dvr-outlined (interop/react-factory DvrOutlined))
(def dvr-rounded (interop/react-factory DvrRounded))
(def dvr-sharp (interop/react-factory DvrSharp))
(def dvr-two-tone (interop/react-factory DvrTwoTone))
(def dynamic-feed (interop/react-factory DynamicFeed))
(def dynamic-feed-outlined (interop/react-factory DynamicFeedOutlined))
(def dynamic-feed-rounded (interop/react-factory DynamicFeedRounded))
(def dynamic-feed-sharp (interop/react-factory DynamicFeedSharp))
(def dynamic-feed-two-tone (interop/react-factory DynamicFeedTwoTone))
(def eco (interop/react-factory Eco))
(def eco-outlined (interop/react-factory EcoOutlined))
(def eco-rounded (interop/react-factory EcoRounded))
(def eco-sharp (interop/react-factory EcoSharp))
(def eco-two-tone (interop/react-factory EcoTwoTone))
(def edit (interop/react-factory Edit))
(def edit-attributes (interop/react-factory EditAttributes))
(def edit-attributes-outlined (interop/react-factory EditAttributesOutlined))
(def edit-attributes-rounded (interop/react-factory EditAttributesRounded))
(def edit-attributes-sharp (interop/react-factory EditAttributesSharp))
(def edit-attributes-two-tone (interop/react-factory EditAttributesTwoTone))
(def edit-location (interop/react-factory EditLocation))
(def edit-location-outlined (interop/react-factory EditLocationOutlined))
(def edit-location-rounded (interop/react-factory EditLocationRounded))
(def edit-location-sharp (interop/react-factory EditLocationSharp))
(def edit-location-two-tone (interop/react-factory EditLocationTwoTone))
(def edit-outlined (interop/react-factory EditOutlined))
(def edit-rounded (interop/react-factory EditRounded))
(def edit-sharp (interop/react-factory EditSharp))
(def edit-two-tone (interop/react-factory EditTwoTone))
(def eject (interop/react-factory Eject))
(def eject-outlined (interop/react-factory EjectOutlined))
(def eject-rounded (interop/react-factory EjectRounded))
(def eject-sharp (interop/react-factory EjectSharp))
(def eject-two-tone (interop/react-factory EjectTwoTone))
(def email (interop/react-factory Email))
(def email-outlined (interop/react-factory EmailOutlined))
(def email-rounded (interop/react-factory EmailRounded))
(def email-sharp (interop/react-factory EmailSharp))
(def email-two-tone (interop/react-factory EmailTwoTone))
(def emoji-emotions (interop/react-factory EmojiEmotions))
(def emoji-emotions-outlined (interop/react-factory EmojiEmotionsOutlined))
(def emoji-emotions-rounded (interop/react-factory EmojiEmotionsRounded))
(def emoji-emotions-sharp (interop/react-factory EmojiEmotionsSharp))
(def emoji-emotions-two-tone (interop/react-factory EmojiEmotionsTwoTone))
(def emoji-events (interop/react-factory EmojiEvents))
(def emoji-events-outlined (interop/react-factory EmojiEventsOutlined))
(def emoji-events-rounded (interop/react-factory EmojiEventsRounded))
(def emoji-events-sharp (interop/react-factory EmojiEventsSharp))
(def emoji-events-two-tone (interop/react-factory EmojiEventsTwoTone))
(def emoji-flags (interop/react-factory EmojiFlags))
(def emoji-flags-outlined (interop/react-factory EmojiFlagsOutlined))
(def emoji-flags-rounded (interop/react-factory EmojiFlagsRounded))
(def emoji-flags-sharp (interop/react-factory EmojiFlagsSharp))
(def emoji-flags-two-tone (interop/react-factory EmojiFlagsTwoTone))
(def emoji-food-beverage (interop/react-factory EmojiFoodBeverage))
(def emoji-food-beverage-outlined (interop/react-factory EmojiFoodBeverageOutlined))
(def emoji-food-beverage-rounded (interop/react-factory EmojiFoodBeverageRounded))
(def emoji-food-beverage-sharp (interop/react-factory EmojiFoodBeverageSharp))
(def emoji-food-beverage-two-tone (interop/react-factory EmojiFoodBeverageTwoTone))
(def emoji-nature (interop/react-factory EmojiNature))
(def emoji-nature-outlined (interop/react-factory EmojiNatureOutlined))
(def emoji-nature-rounded (interop/react-factory EmojiNatureRounded))
(def emoji-nature-sharp (interop/react-factory EmojiNatureSharp))
(def emoji-nature-two-tone (interop/react-factory EmojiNatureTwoTone))
(def emoji-objects (interop/react-factory EmojiObjects))
(def emoji-objects-outlined (interop/react-factory EmojiObjectsOutlined))
(def emoji-objects-rounded (interop/react-factory EmojiObjectsRounded))
(def emoji-objects-sharp (interop/react-factory EmojiObjectsSharp))
(def emoji-objects-two-tone (interop/react-factory EmojiObjectsTwoTone))
(def emoji-people (interop/react-factory EmojiPeople))
(def emoji-people-outlined (interop/react-factory EmojiPeopleOutlined))
(def emoji-people-rounded (interop/react-factory EmojiPeopleRounded))
(def emoji-people-sharp (interop/react-factory EmojiPeopleSharp))
(def emoji-people-two-tone (interop/react-factory EmojiPeopleTwoTone))
(def emoji-symbols (interop/react-factory EmojiSymbols))
(def emoji-symbols-outlined (interop/react-factory EmojiSymbolsOutlined))
(def emoji-symbols-rounded (interop/react-factory EmojiSymbolsRounded))
(def emoji-symbols-sharp (interop/react-factory EmojiSymbolsSharp))
(def emoji-symbols-two-tone (interop/react-factory EmojiSymbolsTwoTone))
(def emoji-transportation (interop/react-factory EmojiTransportation))
(def emoji-transportation-outlined (interop/react-factory EmojiTransportationOutlined))
(def emoji-transportation-rounded (interop/react-factory EmojiTransportationRounded))
(def emoji-transportation-sharp (interop/react-factory EmojiTransportationSharp))
(def emoji-transportation-two-tone (interop/react-factory EmojiTransportationTwoTone))
(def enhanced-encryption (interop/react-factory EnhancedEncryption))
(def enhanced-encryption-outlined (interop/react-factory EnhancedEncryptionOutlined))
(def enhanced-encryption-rounded (interop/react-factory EnhancedEncryptionRounded))
(def enhanced-encryption-sharp (interop/react-factory EnhancedEncryptionSharp))
(def enhanced-encryption-two-tone (interop/react-factory EnhancedEncryptionTwoTone))
(def equalizer (interop/react-factory Equalizer))
(def equalizer-outlined (interop/react-factory EqualizerOutlined))
(def equalizer-rounded (interop/react-factory EqualizerRounded))
(def equalizer-sharp (interop/react-factory EqualizerSharp))
(def equalizer-two-tone (interop/react-factory EqualizerTwoTone))
(def error (interop/react-factory Error))
(def error-outline (interop/react-factory ErrorOutline))
(def error-outlined (interop/react-factory ErrorOutlined))
(def error-outline-outlined (interop/react-factory ErrorOutlineOutlined))
(def error-outline-rounded (interop/react-factory ErrorOutlineRounded))
(def error-outline-sharp (interop/react-factory ErrorOutlineSharp))
(def error-outline-two-tone (interop/react-factory ErrorOutlineTwoTone))
(def error-rounded (interop/react-factory ErrorRounded))
(def error-sharp (interop/react-factory ErrorSharp))
(def error-two-tone (interop/react-factory ErrorTwoTone))
(def euro (interop/react-factory Euro))
(def euro-outlined (interop/react-factory EuroOutlined))
(def euro-rounded (interop/react-factory EuroRounded))
(def euro-sharp (interop/react-factory EuroSharp))
(def euro-symbol (interop/react-factory EuroSymbol))
(def euro-symbol-outlined (interop/react-factory EuroSymbolOutlined))
(def euro-symbol-rounded (interop/react-factory EuroSymbolRounded))
(def euro-symbol-sharp (interop/react-factory EuroSymbolSharp))
(def euro-symbol-two-tone (interop/react-factory EuroSymbolTwoTone))
(def euro-two-tone (interop/react-factory EuroTwoTone))
(def event (interop/react-factory Event))
(def event-available (interop/react-factory EventAvailable))
(def event-available-outlined (interop/react-factory EventAvailableOutlined))
(def event-available-rounded (interop/react-factory EventAvailableRounded))
(def event-available-sharp (interop/react-factory EventAvailableSharp))
(def event-available-two-tone (interop/react-factory EventAvailableTwoTone))
(def event-busy (interop/react-factory EventBusy))
(def event-busy-outlined (interop/react-factory EventBusyOutlined))
(def event-busy-rounded (interop/react-factory EventBusyRounded))
(def event-busy-sharp (interop/react-factory EventBusySharp))
(def event-busy-two-tone (interop/react-factory EventBusyTwoTone))
(def event-note (interop/react-factory EventNote))
(def event-note-outlined (interop/react-factory EventNoteOutlined))
(def event-note-rounded (interop/react-factory EventNoteRounded))
(def event-note-sharp (interop/react-factory EventNoteSharp))
(def event-note-two-tone (interop/react-factory EventNoteTwoTone))
(def event-outlined (interop/react-factory EventOutlined))
(def event-rounded (interop/react-factory EventRounded))
(def event-seat (interop/react-factory EventSeat))
(def event-seat-outlined (interop/react-factory EventSeatOutlined))
(def event-seat-rounded (interop/react-factory EventSeatRounded))
(def event-seat-sharp (interop/react-factory EventSeatSharp))
(def event-seat-two-tone (interop/react-factory EventSeatTwoTone))
(def event-sharp (interop/react-factory EventSharp))
(def event-two-tone (interop/react-factory EventTwoTone))
(def ev-station (interop/react-factory EvStation))
(def ev-station-outlined (interop/react-factory EvStationOutlined))
(def ev-station-rounded (interop/react-factory EvStationRounded))
(def ev-station-sharp (interop/react-factory EvStationSharp))
(def ev-station-two-tone (interop/react-factory EvStationTwoTone))
(def exit-to-app (interop/react-factory ExitToApp))
(def exit-to-app-outlined (interop/react-factory ExitToAppOutlined))
(def exit-to-app-rounded (interop/react-factory ExitToAppRounded))
(def exit-to-app-sharp (interop/react-factory ExitToAppSharp))
(def exit-to-app-two-tone (interop/react-factory ExitToAppTwoTone))
(def expand-less (interop/react-factory ExpandLess))
(def expand-less-outlined (interop/react-factory ExpandLessOutlined))
(def expand-less-rounded (interop/react-factory ExpandLessRounded))
(def expand-less-sharp (interop/react-factory ExpandLessSharp))
(def expand-less-two-tone (interop/react-factory ExpandLessTwoTone))
(def expand-more (interop/react-factory ExpandMore))
(def expand-more-outlined (interop/react-factory ExpandMoreOutlined))
(def expand-more-rounded (interop/react-factory ExpandMoreRounded))
(def expand-more-sharp (interop/react-factory ExpandMoreSharp))
(def expand-more-two-tone (interop/react-factory ExpandMoreTwoTone))
(def explicit (interop/react-factory Explicit))
(def explicit-outlined (interop/react-factory ExplicitOutlined))
(def explicit-rounded (interop/react-factory ExplicitRounded))
(def explicit-sharp (interop/react-factory ExplicitSharp))
(def explicit-two-tone (interop/react-factory ExplicitTwoTone))
(def explore (interop/react-factory Explore))
(def explore-off (interop/react-factory ExploreOff))
(def explore-off-outlined (interop/react-factory ExploreOffOutlined))
(def explore-off-rounded (interop/react-factory ExploreOffRounded))
(def explore-off-sharp (interop/react-factory ExploreOffSharp))
(def explore-off-two-tone (interop/react-factory ExploreOffTwoTone))
(def explore-outlined (interop/react-factory ExploreOutlined))
(def explore-rounded (interop/react-factory ExploreRounded))
(def explore-sharp (interop/react-factory ExploreSharp))
(def explore-two-tone (interop/react-factory ExploreTwoTone))
(def exposure (interop/react-factory Exposure))
(def exposure-neg1 (interop/react-factory ExposureNeg1))
(def exposure-neg1-outlined (interop/react-factory ExposureNeg1Outlined))
(def exposure-neg1-rounded (interop/react-factory ExposureNeg1Rounded))
(def exposure-neg1-sharp (interop/react-factory ExposureNeg1Sharp))
(def exposure-neg1-two-tone (interop/react-factory ExposureNeg1TwoTone))
(def exposure-neg2 (interop/react-factory ExposureNeg2))
(def exposure-neg2-outlined (interop/react-factory ExposureNeg2Outlined))
(def exposure-neg2-rounded (interop/react-factory ExposureNeg2Rounded))
(def exposure-neg2-sharp (interop/react-factory ExposureNeg2Sharp))
(def exposure-neg2-two-tone (interop/react-factory ExposureNeg2TwoTone))
(def exposure-outlined (interop/react-factory ExposureOutlined))
(def exposure-plus1 (interop/react-factory ExposurePlus1))
(def exposure-plus1-outlined (interop/react-factory ExposurePlus1Outlined))
(def exposure-plus1-rounded (interop/react-factory ExposurePlus1Rounded))
(def exposure-plus1-sharp (interop/react-factory ExposurePlus1Sharp))
(def exposure-plus1-two-tone (interop/react-factory ExposurePlus1TwoTone))
(def exposure-plus2 (interop/react-factory ExposurePlus2))
(def exposure-plus2-outlined (interop/react-factory ExposurePlus2Outlined))
(def exposure-plus2-rounded (interop/react-factory ExposurePlus2Rounded))
(def exposure-plus2-sharp (interop/react-factory ExposurePlus2Sharp))
(def exposure-plus2-two-tone (interop/react-factory ExposurePlus2TwoTone))
(def exposure-rounded (interop/react-factory ExposureRounded))
(def exposure-sharp (interop/react-factory ExposureSharp))
(def exposure-two-tone (interop/react-factory ExposureTwoTone))
(def exposure-zero (interop/react-factory ExposureZero))
(def exposure-zero-outlined (interop/react-factory ExposureZeroOutlined))
(def exposure-zero-rounded (interop/react-factory ExposureZeroRounded))
(def exposure-zero-sharp (interop/react-factory ExposureZeroSharp))
(def exposure-zero-two-tone (interop/react-factory ExposureZeroTwoTone))
(def extension (interop/react-factory Extension))
(def extension-outlined (interop/react-factory ExtensionOutlined))
(def extension-rounded (interop/react-factory ExtensionRounded))
(def extension-sharp (interop/react-factory ExtensionSharp))
(def extension-two-tone (interop/react-factory ExtensionTwoTone))
(def face (interop/react-factory Face))
(def facebook (interop/react-factory Facebook))
(def face-outlined (interop/react-factory FaceOutlined))
(def face-rounded (interop/react-factory FaceRounded))
(def face-sharp (interop/react-factory FaceSharp))
(def face-two-tone (interop/react-factory FaceTwoTone))
(def fastfood (interop/react-factory Fastfood))
(def fastfood-outlined (interop/react-factory FastfoodOutlined))
(def fastfood-rounded (interop/react-factory FastfoodRounded))
(def fastfood-sharp (interop/react-factory FastfoodSharp))
(def fastfood-two-tone (interop/react-factory FastfoodTwoTone))
(def fast-forward (interop/react-factory FastForward))
(def fast-forward-outlined (interop/react-factory FastForwardOutlined))
(def fast-forward-rounded (interop/react-factory FastForwardRounded))
(def fast-forward-sharp (interop/react-factory FastForwardSharp))
(def fast-forward-two-tone (interop/react-factory FastForwardTwoTone))
(def fast-rewind (interop/react-factory FastRewind))
(def fast-rewind-outlined (interop/react-factory FastRewindOutlined))
(def fast-rewind-rounded (interop/react-factory FastRewindRounded))
(def fast-rewind-sharp (interop/react-factory FastRewindSharp))
(def fast-rewind-two-tone (interop/react-factory FastRewindTwoTone))
(def favorite (interop/react-factory Favorite))
(def favorite-border (interop/react-factory FavoriteBorder))
(def favorite-border-outlined (interop/react-factory FavoriteBorderOutlined))
(def favorite-border-rounded (interop/react-factory FavoriteBorderRounded))
(def favorite-border-sharp (interop/react-factory FavoriteBorderSharp))
(def favorite-border-two-tone (interop/react-factory FavoriteBorderTwoTone))
(def favorite-outlined (interop/react-factory FavoriteOutlined))
(def favorite-rounded (interop/react-factory FavoriteRounded))
(def favorite-sharp (interop/react-factory FavoriteSharp))
(def favorite-two-tone (interop/react-factory FavoriteTwoTone))
(def featured-play-list (interop/react-factory FeaturedPlayList))
(def featured-play-list-outlined (interop/react-factory FeaturedPlayListOutlined))
(def featured-play-list-rounded (interop/react-factory FeaturedPlayListRounded))
(def featured-play-list-sharp (interop/react-factory FeaturedPlayListSharp))
(def featured-play-list-two-tone (interop/react-factory FeaturedPlayListTwoTone))
(def featured-video (interop/react-factory FeaturedVideo))
(def featured-video-outlined (interop/react-factory FeaturedVideoOutlined))
(def featured-video-rounded (interop/react-factory FeaturedVideoRounded))
(def featured-video-sharp (interop/react-factory FeaturedVideoSharp))
(def featured-video-two-tone (interop/react-factory FeaturedVideoTwoTone))
(def feedback (interop/react-factory Feedback))
(def feedback-outlined (interop/react-factory FeedbackOutlined))
(def feedback-rounded (interop/react-factory FeedbackRounded))
(def feedback-sharp (interop/react-factory FeedbackSharp))
(def feedback-two-tone (interop/react-factory FeedbackTwoTone))
(def fiber-dvr (interop/react-factory FiberDvr))
(def fiber-dvr-outlined (interop/react-factory FiberDvrOutlined))
(def fiber-dvr-rounded (interop/react-factory FiberDvrRounded))
(def fiber-dvr-sharp (interop/react-factory FiberDvrSharp))
(def fiber-dvr-two-tone (interop/react-factory FiberDvrTwoTone))
(def fiber-manual-record (interop/react-factory FiberManualRecord))
(def fiber-manual-record-outlined (interop/react-factory FiberManualRecordOutlined))
(def fiber-manual-record-rounded (interop/react-factory FiberManualRecordRounded))
(def fiber-manual-record-sharp (interop/react-factory FiberManualRecordSharp))
(def fiber-manual-record-two-tone (interop/react-factory FiberManualRecordTwoTone))
(def fiber-new (interop/react-factory FiberNew))
(def fiber-new-outlined (interop/react-factory FiberNewOutlined))
(def fiber-new-rounded (interop/react-factory FiberNewRounded))
(def fiber-new-sharp (interop/react-factory FiberNewSharp))
(def fiber-new-two-tone (interop/react-factory FiberNewTwoTone))
(def fiber-pin (interop/react-factory FiberPin))
(def fiber-pin-outlined (interop/react-factory FiberPinOutlined))
(def fiber-pin-rounded (interop/react-factory FiberPinRounded))
(def fiber-pin-sharp (interop/react-factory FiberPinSharp))
(def fiber-pin-two-tone (interop/react-factory FiberPinTwoTone))
(def fiber-smart-record (interop/react-factory FiberSmartRecord))
(def fiber-smart-record-outlined (interop/react-factory FiberSmartRecordOutlined))
(def fiber-smart-record-rounded (interop/react-factory FiberSmartRecordRounded))
(def fiber-smart-record-sharp (interop/react-factory FiberSmartRecordSharp))
(def fiber-smart-record-two-tone (interop/react-factory FiberSmartRecordTwoTone))
(def file-copy (interop/react-factory FileCopy))
(def file-copy-outlined (interop/react-factory FileCopyOutlined))
(def file-copy-rounded (interop/react-factory FileCopyRounded))
(def file-copy-sharp (interop/react-factory FileCopySharp))
(def file-copy-two-tone (interop/react-factory FileCopyTwoTone))
(def filter (interop/react-factory Filter))
(def filter1 (interop/react-factory Filter1))
(def filter1-outlined (interop/react-factory Filter1Outlined))
(def filter1-rounded (interop/react-factory Filter1Rounded))
(def filter1-sharp (interop/react-factory Filter1Sharp))
(def filter1-two-tone (interop/react-factory Filter1TwoTone))
(def filter2 (interop/react-factory Filter2))
(def filter2-outlined (interop/react-factory Filter2Outlined))
(def filter2-rounded (interop/react-factory Filter2Rounded))
(def filter2-sharp (interop/react-factory Filter2Sharp))
(def filter2-two-tone (interop/react-factory Filter2TwoTone))
(def filter3 (interop/react-factory Filter3))
(def filter3-outlined (interop/react-factory Filter3Outlined))
(def filter3-rounded (interop/react-factory Filter3Rounded))
(def filter3-sharp (interop/react-factory Filter3Sharp))
(def filter3-two-tone (interop/react-factory Filter3TwoTone))
(def filter4 (interop/react-factory Filter4))
(def filter4-outlined (interop/react-factory Filter4Outlined))
(def filter4-rounded (interop/react-factory Filter4Rounded))
(def filter4-sharp (interop/react-factory Filter4Sharp))
(def filter4-two-tone (interop/react-factory Filter4TwoTone))
(def filter5 (interop/react-factory Filter5))
(def filter5-outlined (interop/react-factory Filter5Outlined))
(def filter5-rounded (interop/react-factory Filter5Rounded))
(def filter5-sharp (interop/react-factory Filter5Sharp))
(def filter5-two-tone (interop/react-factory Filter5TwoTone))
(def filter6 (interop/react-factory Filter6))
(def filter6-outlined (interop/react-factory Filter6Outlined))
(def filter6-rounded (interop/react-factory Filter6Rounded))
(def filter6-sharp (interop/react-factory Filter6Sharp))
(def filter6-two-tone (interop/react-factory Filter6TwoTone))
(def filter7 (interop/react-factory Filter7))
(def filter7-outlined (interop/react-factory Filter7Outlined))
(def filter7-rounded (interop/react-factory Filter7Rounded))
(def filter7-sharp (interop/react-factory Filter7Sharp))
(def filter7-two-tone (interop/react-factory Filter7TwoTone))
(def filter8 (interop/react-factory Filter8))
(def filter8-outlined (interop/react-factory Filter8Outlined))
(def filter8-rounded (interop/react-factory Filter8Rounded))
(def filter8-sharp (interop/react-factory Filter8Sharp))
(def filter8-two-tone (interop/react-factory Filter8TwoTone))
(def filter9 (interop/react-factory Filter9))
(def filter9-outlined (interop/react-factory Filter9Outlined))
(def filter9-plus (interop/react-factory Filter9Plus))
(def filter9-plus-outlined (interop/react-factory Filter9PlusOutlined))
(def filter9-plus-rounded (interop/react-factory Filter9PlusRounded))
(def filter9-plus-sharp (interop/react-factory Filter9PlusSharp))
(def filter9-plus-two-tone (interop/react-factory Filter9PlusTwoTone))
(def filter9-rounded (interop/react-factory Filter9Rounded))
(def filter9-sharp (interop/react-factory Filter9Sharp))
(def filter9-two-tone (interop/react-factory Filter9TwoTone))
(def filter-b-and-w (interop/react-factory FilterBAndW))
(def filter-b-and-w-outlined (interop/react-factory FilterBAndWOutlined))
(def filter-b-and-w-rounded (interop/react-factory FilterBAndWRounded))
(def filter-b-and-w-sharp (interop/react-factory FilterBAndWSharp))
(def filter-b-and-w-two-tone (interop/react-factory FilterBAndWTwoTone))
(def filter-center-focus (interop/react-factory FilterCenterFocus))
(def filter-center-focus-outlined (interop/react-factory FilterCenterFocusOutlined))
(def filter-center-focus-rounded (interop/react-factory FilterCenterFocusRounded))
(def filter-center-focus-sharp (interop/react-factory FilterCenterFocusSharp))
(def filter-center-focus-two-tone (interop/react-factory FilterCenterFocusTwoTone))
(def filter-drama (interop/react-factory FilterDrama))
(def filter-drama-outlined (interop/react-factory FilterDramaOutlined))
(def filter-drama-rounded (interop/react-factory FilterDramaRounded))
(def filter-drama-sharp (interop/react-factory FilterDramaSharp))
(def filter-drama-two-tone (interop/react-factory FilterDramaTwoTone))
(def filter-frames (interop/react-factory FilterFrames))
(def filter-frames-outlined (interop/react-factory FilterFramesOutlined))
(def filter-frames-rounded (interop/react-factory FilterFramesRounded))
(def filter-frames-sharp (interop/react-factory FilterFramesSharp))
(def filter-frames-two-tone (interop/react-factory FilterFramesTwoTone))
(def filter-hdr (interop/react-factory FilterHdr))
(def filter-hdr-outlined (interop/react-factory FilterHdrOutlined))
(def filter-hdr-rounded (interop/react-factory FilterHdrRounded))
(def filter-hdr-sharp (interop/react-factory FilterHdrSharp))
(def filter-hdr-two-tone (interop/react-factory FilterHdrTwoTone))
(def filter-list (interop/react-factory FilterList))
(def filter-list-outlined (interop/react-factory FilterListOutlined))
(def filter-list-rounded (interop/react-factory FilterListRounded))
(def filter-list-sharp (interop/react-factory FilterListSharp))
(def filter-list-two-tone (interop/react-factory FilterListTwoTone))
(def filter-none (interop/react-factory FilterNone))
(def filter-none-outlined (interop/react-factory FilterNoneOutlined))
(def filter-none-rounded (interop/react-factory FilterNoneRounded))
(def filter-none-sharp (interop/react-factory FilterNoneSharp))
(def filter-none-two-tone (interop/react-factory FilterNoneTwoTone))
(def filter-outlined (interop/react-factory FilterOutlined))
(def filter-rounded (interop/react-factory FilterRounded))
(def filter-sharp (interop/react-factory FilterSharp))
(def filter-tilt-shift (interop/react-factory FilterTiltShift))
(def filter-tilt-shift-outlined (interop/react-factory FilterTiltShiftOutlined))
(def filter-tilt-shift-rounded (interop/react-factory FilterTiltShiftRounded))
(def filter-tilt-shift-sharp (interop/react-factory FilterTiltShiftSharp))
(def filter-tilt-shift-two-tone (interop/react-factory FilterTiltShiftTwoTone))
(def filter-two-tone (interop/react-factory FilterTwoTone))
(def filter-vintage (interop/react-factory FilterVintage))
(def filter-vintage-outlined (interop/react-factory FilterVintageOutlined))
(def filter-vintage-rounded (interop/react-factory FilterVintageRounded))
(def filter-vintage-sharp (interop/react-factory FilterVintageSharp))
(def filter-vintage-two-tone (interop/react-factory FilterVintageTwoTone))
(def find-in-page (interop/react-factory FindInPage))
(def find-in-page-outlined (interop/react-factory FindInPageOutlined))
(def find-in-page-rounded (interop/react-factory FindInPageRounded))
(def find-in-page-sharp (interop/react-factory FindInPageSharp))
(def find-in-page-two-tone (interop/react-factory FindInPageTwoTone))
(def find-replace (interop/react-factory FindReplace))
(def find-replace-outlined (interop/react-factory FindReplaceOutlined))
(def find-replace-rounded (interop/react-factory FindReplaceRounded))
(def find-replace-sharp (interop/react-factory FindReplaceSharp))
(def find-replace-two-tone (interop/react-factory FindReplaceTwoTone))
(def fingerprint (interop/react-factory Fingerprint))
(def fingerprint-outlined (interop/react-factory FingerprintOutlined))
(def fingerprint-rounded (interop/react-factory FingerprintRounded))
(def fingerprint-sharp (interop/react-factory FingerprintSharp))
(def fingerprint-two-tone (interop/react-factory FingerprintTwoTone))
(def fireplace (interop/react-factory Fireplace))
(def fireplace-outlined (interop/react-factory FireplaceOutlined))
(def fireplace-rounded (interop/react-factory FireplaceRounded))
(def fireplace-sharp (interop/react-factory FireplaceSharp))
(def fireplace-two-tone (interop/react-factory FireplaceTwoTone))
(def first-page (interop/react-factory FirstPage))
(def first-page-outlined (interop/react-factory FirstPageOutlined))
(def first-page-rounded (interop/react-factory FirstPageRounded))
(def first-page-sharp (interop/react-factory FirstPageSharp))
(def first-page-two-tone (interop/react-factory FirstPageTwoTone))
(def fitness-center (interop/react-factory FitnessCenter))
(def fitness-center-outlined (interop/react-factory FitnessCenterOutlined))
(def fitness-center-rounded (interop/react-factory FitnessCenterRounded))
(def fitness-center-sharp (interop/react-factory FitnessCenterSharp))
(def fitness-center-two-tone (interop/react-factory FitnessCenterTwoTone))
(def flag (interop/react-factory Flag))
(def flag-outlined (interop/react-factory FlagOutlined))
(def flag-rounded (interop/react-factory FlagRounded))
(def flag-sharp (interop/react-factory FlagSharp))
(def flag-two-tone (interop/react-factory FlagTwoTone))
(def flare (interop/react-factory Flare))
(def flare-outlined (interop/react-factory FlareOutlined))
(def flare-rounded (interop/react-factory FlareRounded))
(def flare-sharp (interop/react-factory FlareSharp))
(def flare-two-tone (interop/react-factory FlareTwoTone))
(def flash-auto (interop/react-factory FlashAuto))
(def flash-auto-outlined (interop/react-factory FlashAutoOutlined))
(def flash-auto-rounded (interop/react-factory FlashAutoRounded))
(def flash-auto-sharp (interop/react-factory FlashAutoSharp))
(def flash-auto-two-tone (interop/react-factory FlashAutoTwoTone))
(def flash-off (interop/react-factory FlashOff))
(def flash-off-outlined (interop/react-factory FlashOffOutlined))
(def flash-off-rounded (interop/react-factory FlashOffRounded))
(def flash-off-sharp (interop/react-factory FlashOffSharp))
(def flash-off-two-tone (interop/react-factory FlashOffTwoTone))
(def flash-on (interop/react-factory FlashOn))
(def flash-on-outlined (interop/react-factory FlashOnOutlined))
(def flash-on-rounded (interop/react-factory FlashOnRounded))
(def flash-on-sharp (interop/react-factory FlashOnSharp))
(def flash-on-two-tone (interop/react-factory FlashOnTwoTone))
(def flight (interop/react-factory Flight))
(def flight-land (interop/react-factory FlightLand))
(def flight-land-outlined (interop/react-factory FlightLandOutlined))
(def flight-land-rounded (interop/react-factory FlightLandRounded))
(def flight-land-sharp (interop/react-factory FlightLandSharp))
(def flight-land-two-tone (interop/react-factory FlightLandTwoTone))
(def flight-outlined (interop/react-factory FlightOutlined))
(def flight-rounded (interop/react-factory FlightRounded))
(def flight-sharp (interop/react-factory FlightSharp))
(def flight-takeoff (interop/react-factory FlightTakeoff))
(def flight-takeoff-outlined (interop/react-factory FlightTakeoffOutlined))
(def flight-takeoff-rounded (interop/react-factory FlightTakeoffRounded))
(def flight-takeoff-sharp (interop/react-factory FlightTakeoffSharp))
(def flight-takeoff-two-tone (interop/react-factory FlightTakeoffTwoTone))
(def flight-two-tone (interop/react-factory FlightTwoTone))
(def flip (interop/react-factory Flip))
(def flip-camera-android (interop/react-factory FlipCameraAndroid))
(def flip-camera-android-outlined (interop/react-factory FlipCameraAndroidOutlined))
(def flip-camera-android-rounded (interop/react-factory FlipCameraAndroidRounded))
(def flip-camera-android-sharp (interop/react-factory FlipCameraAndroidSharp))
(def flip-camera-android-two-tone (interop/react-factory FlipCameraAndroidTwoTone))
(def flip-camera-ios (interop/react-factory FlipCameraIos))
(def flip-camera-ios-outlined (interop/react-factory FlipCameraIosOutlined))
(def flip-camera-ios-rounded (interop/react-factory FlipCameraIosRounded))
(def flip-camera-ios-sharp (interop/react-factory FlipCameraIosSharp))
(def flip-camera-ios-two-tone (interop/react-factory FlipCameraIosTwoTone))
(def flip-outlined (interop/react-factory FlipOutlined))
(def flip-rounded (interop/react-factory FlipRounded))
(def flip-sharp (interop/react-factory FlipSharp))
(def flip-to-back (interop/react-factory FlipToBack))
(def flip-to-back-outlined (interop/react-factory FlipToBackOutlined))
(def flip-to-back-rounded (interop/react-factory FlipToBackRounded))
(def flip-to-back-sharp (interop/react-factory FlipToBackSharp))
(def flip-to-back-two-tone (interop/react-factory FlipToBackTwoTone))
(def flip-to-front (interop/react-factory FlipToFront))
(def flip-to-front-outlined (interop/react-factory FlipToFrontOutlined))
(def flip-to-front-rounded (interop/react-factory FlipToFrontRounded))
(def flip-to-front-sharp (interop/react-factory FlipToFrontSharp))
(def flip-to-front-two-tone (interop/react-factory FlipToFrontTwoTone))
(def flip-two-tone (interop/react-factory FlipTwoTone))
(def folder (interop/react-factory Folder))
(def folder-open (interop/react-factory FolderOpen))
(def folder-open-outlined (interop/react-factory FolderOpenOutlined))
(def folder-open-rounded (interop/react-factory FolderOpenRounded))
(def folder-open-sharp (interop/react-factory FolderOpenSharp))
(def folder-open-two-tone (interop/react-factory FolderOpenTwoTone))
(def folder-outlined (interop/react-factory FolderOutlined))
(def folder-rounded (interop/react-factory FolderRounded))
(def folder-shared (interop/react-factory FolderShared))
(def folder-shared-outlined (interop/react-factory FolderSharedOutlined))
(def folder-shared-rounded (interop/react-factory FolderSharedRounded))
(def folder-shared-sharp (interop/react-factory FolderSharedSharp))
(def folder-shared-two-tone (interop/react-factory FolderSharedTwoTone))
(def folder-sharp (interop/react-factory FolderSharp))
(def folder-special (interop/react-factory FolderSpecial))
(def folder-special-outlined (interop/react-factory FolderSpecialOutlined))
(def folder-special-rounded (interop/react-factory FolderSpecialRounded))
(def folder-special-sharp (interop/react-factory FolderSpecialSharp))
(def folder-special-two-tone (interop/react-factory FolderSpecialTwoTone))
(def folder-two-tone (interop/react-factory FolderTwoTone))
(def font-download (interop/react-factory FontDownload))
(def font-download-outlined (interop/react-factory FontDownloadOutlined))
(def font-download-rounded (interop/react-factory FontDownloadRounded))
(def font-download-sharp (interop/react-factory FontDownloadSharp))
(def font-download-two-tone (interop/react-factory FontDownloadTwoTone))
(def format-align-center (interop/react-factory FormatAlignCenter))
(def format-align-center-outlined (interop/react-factory FormatAlignCenterOutlined))
(def format-align-center-rounded (interop/react-factory FormatAlignCenterRounded))
(def format-align-center-sharp (interop/react-factory FormatAlignCenterSharp))
(def format-align-center-two-tone (interop/react-factory FormatAlignCenterTwoTone))
(def format-align-justify (interop/react-factory FormatAlignJustify))
(def format-align-justify-outlined (interop/react-factory FormatAlignJustifyOutlined))
(def format-align-justify-rounded (interop/react-factory FormatAlignJustifyRounded))
(def format-align-justify-sharp (interop/react-factory FormatAlignJustifySharp))
(def format-align-justify-two-tone (interop/react-factory FormatAlignJustifyTwoTone))
(def format-align-left (interop/react-factory FormatAlignLeft))
(def format-align-left-outlined (interop/react-factory FormatAlignLeftOutlined))
(def format-align-left-rounded (interop/react-factory FormatAlignLeftRounded))
(def format-align-left-sharp (interop/react-factory FormatAlignLeftSharp))
(def format-align-left-two-tone (interop/react-factory FormatAlignLeftTwoTone))
(def format-align-right (interop/react-factory FormatAlignRight))
(def format-align-right-outlined (interop/react-factory FormatAlignRightOutlined))
(def format-align-right-rounded (interop/react-factory FormatAlignRightRounded))
(def format-align-right-sharp (interop/react-factory FormatAlignRightSharp))
(def format-align-right-two-tone (interop/react-factory FormatAlignRightTwoTone))
(def format-bold (interop/react-factory FormatBold))
(def format-bold-outlined (interop/react-factory FormatBoldOutlined))
(def format-bold-rounded (interop/react-factory FormatBoldRounded))
(def format-bold-sharp (interop/react-factory FormatBoldSharp))
(def format-bold-two-tone (interop/react-factory FormatBoldTwoTone))
(def format-clear (interop/react-factory FormatClear))
(def format-clear-outlined (interop/react-factory FormatClearOutlined))
(def format-clear-rounded (interop/react-factory FormatClearRounded))
(def format-clear-sharp (interop/react-factory FormatClearSharp))
(def format-clear-two-tone (interop/react-factory FormatClearTwoTone))
(def format-color-fill (interop/react-factory FormatColorFill))
(def format-color-fill-outlined (interop/react-factory FormatColorFillOutlined))
(def format-color-fill-rounded (interop/react-factory FormatColorFillRounded))
(def format-color-fill-sharp (interop/react-factory FormatColorFillSharp))
(def format-color-fill-two-tone (interop/react-factory FormatColorFillTwoTone))
(def format-color-reset (interop/react-factory FormatColorReset))
(def format-color-reset-outlined (interop/react-factory FormatColorResetOutlined))
(def format-color-reset-rounded (interop/react-factory FormatColorResetRounded))
(def format-color-reset-sharp (interop/react-factory FormatColorResetSharp))
(def format-color-reset-two-tone (interop/react-factory FormatColorResetTwoTone))
(def format-color-text (interop/react-factory FormatColorText))
(def format-color-text-outlined (interop/react-factory FormatColorTextOutlined))
(def format-color-text-rounded (interop/react-factory FormatColorTextRounded))
(def format-color-text-sharp (interop/react-factory FormatColorTextSharp))
(def format-color-text-two-tone (interop/react-factory FormatColorTextTwoTone))
(def format-indent-decrease (interop/react-factory FormatIndentDecrease))
(def format-indent-decrease-outlined (interop/react-factory FormatIndentDecreaseOutlined))
(def format-indent-decrease-rounded (interop/react-factory FormatIndentDecreaseRounded))
(def format-indent-decrease-sharp (interop/react-factory FormatIndentDecreaseSharp))
(def format-indent-decrease-two-tone (interop/react-factory FormatIndentDecreaseTwoTone))
(def format-indent-increase (interop/react-factory FormatIndentIncrease))
(def format-indent-increase-outlined (interop/react-factory FormatIndentIncreaseOutlined))
(def format-indent-increase-rounded (interop/react-factory FormatIndentIncreaseRounded))
(def format-indent-increase-sharp (interop/react-factory FormatIndentIncreaseSharp))
(def format-indent-increase-two-tone (interop/react-factory FormatIndentIncreaseTwoTone))
(def format-italic (interop/react-factory FormatItalic))
(def format-italic-outlined (interop/react-factory FormatItalicOutlined))
(def format-italic-rounded (interop/react-factory FormatItalicRounded))
(def format-italic-sharp (interop/react-factory FormatItalicSharp))
(def format-italic-two-tone (interop/react-factory FormatItalicTwoTone))
(def format-line-spacing (interop/react-factory FormatLineSpacing))
(def format-line-spacing-outlined (interop/react-factory FormatLineSpacingOutlined))
(def format-line-spacing-rounded (interop/react-factory FormatLineSpacingRounded))
(def format-line-spacing-sharp (interop/react-factory FormatLineSpacingSharp))
(def format-line-spacing-two-tone (interop/react-factory FormatLineSpacingTwoTone))
(def format-list-bulleted (interop/react-factory FormatListBulleted))
(def format-list-bulleted-outlined (interop/react-factory FormatListBulletedOutlined))
(def format-list-bulleted-rounded (interop/react-factory FormatListBulletedRounded))
(def format-list-bulleted-sharp (interop/react-factory FormatListBulletedSharp))
(def format-list-bulleted-two-tone (interop/react-factory FormatListBulletedTwoTone))
(def format-list-numbered (interop/react-factory FormatListNumbered))
(def format-list-numbered-outlined (interop/react-factory FormatListNumberedOutlined))
(def format-list-numbered-rounded (interop/react-factory FormatListNumberedRounded))
(def format-list-numbered-rtl (interop/react-factory FormatListNumberedRtl))
(def format-list-numbered-rtl-outlined (interop/react-factory FormatListNumberedRtlOutlined))
(def format-list-numbered-rtl-rounded (interop/react-factory FormatListNumberedRtlRounded))
(def format-list-numbered-rtl-sharp (interop/react-factory FormatListNumberedRtlSharp))
(def format-list-numbered-rtl-two-tone (interop/react-factory FormatListNumberedRtlTwoTone))
(def format-list-numbered-sharp (interop/react-factory FormatListNumberedSharp))
(def format-list-numbered-two-tone (interop/react-factory FormatListNumberedTwoTone))
(def format-paint (interop/react-factory FormatPaint))
(def format-paint-outlined (interop/react-factory FormatPaintOutlined))
(def format-paint-rounded (interop/react-factory FormatPaintRounded))
(def format-paint-sharp (interop/react-factory FormatPaintSharp))
(def format-paint-two-tone (interop/react-factory FormatPaintTwoTone))
(def format-quote (interop/react-factory FormatQuote))
(def format-quote-outlined (interop/react-factory FormatQuoteOutlined))
(def format-quote-rounded (interop/react-factory FormatQuoteRounded))
(def format-quote-sharp (interop/react-factory FormatQuoteSharp))
(def format-quote-two-tone (interop/react-factory FormatQuoteTwoTone))
(def format-shapes (interop/react-factory FormatShapes))
(def format-shapes-outlined (interop/react-factory FormatShapesOutlined))
(def format-shapes-rounded (interop/react-factory FormatShapesRounded))
(def format-shapes-sharp (interop/react-factory FormatShapesSharp))
(def format-shapes-two-tone (interop/react-factory FormatShapesTwoTone))
(def format-size (interop/react-factory FormatSize))
(def format-size-outlined (interop/react-factory FormatSizeOutlined))
(def format-size-rounded (interop/react-factory FormatSizeRounded))
(def format-size-sharp (interop/react-factory FormatSizeSharp))
(def format-size-two-tone (interop/react-factory FormatSizeTwoTone))
(def format-strikethrough (interop/react-factory FormatStrikethrough))
(def format-strikethrough-outlined (interop/react-factory FormatStrikethroughOutlined))
(def format-strikethrough-rounded (interop/react-factory FormatStrikethroughRounded))
(def format-strikethrough-sharp (interop/react-factory FormatStrikethroughSharp))
(def format-strikethrough-two-tone (interop/react-factory FormatStrikethroughTwoTone))
(def format-textdirection-l-to-r (interop/react-factory FormatTextdirectionLToR))
(def format-textdirection-l-to-r-outlined (interop/react-factory FormatTextdirectionLToROutlined))
(def format-textdirection-l-to-r-rounded (interop/react-factory FormatTextdirectionLToRRounded))
(def format-textdirection-l-to-r-sharp (interop/react-factory FormatTextdirectionLToRSharp))
(def format-textdirection-l-to-r-two-tone (interop/react-factory FormatTextdirectionLToRTwoTone))
(def format-textdirection-r-to-l (interop/react-factory FormatTextdirectionRToL))
(def format-textdirection-r-to-l-outlined (interop/react-factory FormatTextdirectionRToLOutlined))
(def format-textdirection-r-to-l-rounded (interop/react-factory FormatTextdirectionRToLRounded))
(def format-textdirection-r-to-l-sharp (interop/react-factory FormatTextdirectionRToLSharp))
(def format-textdirection-r-to-l-two-tone (interop/react-factory FormatTextdirectionRToLTwoTone))
(def format-underlined (interop/react-factory FormatUnderlined))
(def format-underlined-outlined (interop/react-factory FormatUnderlinedOutlined))
(def format-underlined-rounded (interop/react-factory FormatUnderlinedRounded))
(def format-underlined-sharp (interop/react-factory FormatUnderlinedSharp))
(def format-underlined-two-tone (interop/react-factory FormatUnderlinedTwoTone))
(def forum (interop/react-factory Forum))
(def forum-outlined (interop/react-factory ForumOutlined))
(def forum-rounded (interop/react-factory ForumRounded))
(def forum-sharp (interop/react-factory ForumSharp))
(def forum-two-tone (interop/react-factory ForumTwoTone))
(def forward (interop/react-factory Forward))
(def forward10 (interop/react-factory Forward10))
(def forward10-outlined (interop/react-factory Forward10Outlined))
(def forward10-rounded (interop/react-factory Forward10Rounded))
(def forward10-sharp (interop/react-factory Forward10Sharp))
(def forward10-two-tone (interop/react-factory Forward10TwoTone))
(def forward30 (interop/react-factory Forward30))
(def forward30-outlined (interop/react-factory Forward30Outlined))
(def forward30-rounded (interop/react-factory Forward30Rounded))
(def forward30-sharp (interop/react-factory Forward30Sharp))
(def forward30-two-tone (interop/react-factory Forward30TwoTone))
(def forward5 (interop/react-factory Forward5))
(def forward5-outlined (interop/react-factory Forward5Outlined))
(def forward5-rounded (interop/react-factory Forward5Rounded))
(def forward5-sharp (interop/react-factory Forward5Sharp))
(def forward5-two-tone (interop/react-factory Forward5TwoTone))
(def forward-outlined (interop/react-factory ForwardOutlined))
(def forward-rounded (interop/react-factory ForwardRounded))
(def forward-sharp (interop/react-factory ForwardSharp))
(def forward-two-tone (interop/react-factory ForwardTwoTone))
(def four-k (interop/react-factory FourK))
(def four-k-outlined (interop/react-factory FourKOutlined))
(def four-k-rounded (interop/react-factory FourKRounded))
(def four-k-sharp (interop/react-factory FourKSharp))
(def four-k-two-tone (interop/react-factory FourKTwoTone))
(def free-breakfast (interop/react-factory FreeBreakfast))
(def free-breakfast-outlined (interop/react-factory FreeBreakfastOutlined))
(def free-breakfast-rounded (interop/react-factory FreeBreakfastRounded))
(def free-breakfast-sharp (interop/react-factory FreeBreakfastSharp))
(def free-breakfast-two-tone (interop/react-factory FreeBreakfastTwoTone))
(def fullscreen (interop/react-factory Fullscreen))
(def fullscreen-exit (interop/react-factory FullscreenExit))
(def fullscreen-exit-outlined (interop/react-factory FullscreenExitOutlined))
(def fullscreen-exit-rounded (interop/react-factory FullscreenExitRounded))
(def fullscreen-exit-sharp (interop/react-factory FullscreenExitSharp))
(def fullscreen-exit-two-tone (interop/react-factory FullscreenExitTwoTone))
(def fullscreen-outlined (interop/react-factory FullscreenOutlined))
(def fullscreen-rounded (interop/react-factory FullscreenRounded))
(def fullscreen-sharp (interop/react-factory FullscreenSharp))
(def fullscreen-two-tone (interop/react-factory FullscreenTwoTone))
(def functions (interop/react-factory Functions))
(def functions-outlined (interop/react-factory FunctionsOutlined))
(def functions-rounded (interop/react-factory FunctionsRounded))
(def functions-sharp (interop/react-factory FunctionsSharp))
(def functions-two-tone (interop/react-factory FunctionsTwoTone))
(def gamepad (interop/react-factory Gamepad))
(def gamepad-outlined (interop/react-factory GamepadOutlined))
(def gamepad-rounded (interop/react-factory GamepadRounded))
(def gamepad-sharp (interop/react-factory GamepadSharp))
(def gamepad-two-tone (interop/react-factory GamepadTwoTone))
(def games (interop/react-factory Games))
(def games-outlined (interop/react-factory GamesOutlined))
(def games-rounded (interop/react-factory GamesRounded))
(def games-sharp (interop/react-factory GamesSharp))
(def games-two-tone (interop/react-factory GamesTwoTone))
(def gavel (interop/react-factory Gavel))
(def gavel-outlined (interop/react-factory GavelOutlined))
(def gavel-rounded (interop/react-factory GavelRounded))
(def gavel-sharp (interop/react-factory GavelSharp))
(def gavel-two-tone (interop/react-factory GavelTwoTone))
(def gesture (interop/react-factory Gesture))
(def gesture-outlined (interop/react-factory GestureOutlined))
(def gesture-rounded (interop/react-factory GestureRounded))
(def gesture-sharp (interop/react-factory GestureSharp))
(def gesture-two-tone (interop/react-factory GestureTwoTone))
(def get-app (interop/react-factory GetApp))
(def get-app-outlined (interop/react-factory GetAppOutlined))
(def get-app-rounded (interop/react-factory GetAppRounded))
(def get-app-sharp (interop/react-factory GetAppSharp))
(def get-app-two-tone (interop/react-factory GetAppTwoTone))
(def gif (interop/react-factory Gif))
(def gif-outlined (interop/react-factory GifOutlined))
(def gif-rounded (interop/react-factory GifRounded))
(def gif-sharp (interop/react-factory GifSharp))
(def gif-two-tone (interop/react-factory GifTwoTone))
(def git-hub (interop/react-factory GitHub))
(def golf-course (interop/react-factory GolfCourse))
(def golf-course-outlined (interop/react-factory GolfCourseOutlined))
(def golf-course-rounded (interop/react-factory GolfCourseRounded))
(def golf-course-sharp (interop/react-factory GolfCourseSharp))
(def golf-course-two-tone (interop/react-factory GolfCourseTwoTone))
(def gps-fixed (interop/react-factory GpsFixed))
(def gps-fixed-outlined (interop/react-factory GpsFixedOutlined))
(def gps-fixed-rounded (interop/react-factory GpsFixedRounded))
(def gps-fixed-sharp (interop/react-factory GpsFixedSharp))
(def gps-fixed-two-tone (interop/react-factory GpsFixedTwoTone))
(def gps-not-fixed (interop/react-factory GpsNotFixed))
(def gps-not-fixed-outlined (interop/react-factory GpsNotFixedOutlined))
(def gps-not-fixed-rounded (interop/react-factory GpsNotFixedRounded))
(def gps-not-fixed-sharp (interop/react-factory GpsNotFixedSharp))
(def gps-not-fixed-two-tone (interop/react-factory GpsNotFixedTwoTone))
(def gps-off (interop/react-factory GpsOff))
(def gps-off-outlined (interop/react-factory GpsOffOutlined))
(def gps-off-rounded (interop/react-factory GpsOffRounded))
(def gps-off-sharp (interop/react-factory GpsOffSharp))
(def gps-off-two-tone (interop/react-factory GpsOffTwoTone))
(def grade (interop/react-factory Grade))
(def grade-outlined (interop/react-factory GradeOutlined))
(def grade-rounded (interop/react-factory GradeRounded))
(def grade-sharp (interop/react-factory GradeSharp))
(def grade-two-tone (interop/react-factory GradeTwoTone))
(def gradient (interop/react-factory Gradient))
(def gradient-outlined (interop/react-factory GradientOutlined))
(def gradient-rounded (interop/react-factory GradientRounded))
(def gradient-sharp (interop/react-factory GradientSharp))
(def gradient-two-tone (interop/react-factory GradientTwoTone))
(def grain (interop/react-factory Grain))
(def grain-outlined (interop/react-factory GrainOutlined))
(def grain-rounded (interop/react-factory GrainRounded))
(def grain-sharp (interop/react-factory GrainSharp))
(def grain-two-tone (interop/react-factory GrainTwoTone))
(def graphic-eq (interop/react-factory GraphicEq))
(def graphic-eq-outlined (interop/react-factory GraphicEqOutlined))
(def graphic-eq-rounded (interop/react-factory GraphicEqRounded))
(def graphic-eq-sharp (interop/react-factory GraphicEqSharp))
(def graphic-eq-two-tone (interop/react-factory GraphicEqTwoTone))
(def grid-off (interop/react-factory GridOff))
(def grid-off-outlined (interop/react-factory GridOffOutlined))
(def grid-off-rounded (interop/react-factory GridOffRounded))
(def grid-off-sharp (interop/react-factory GridOffSharp))
(def grid-off-two-tone (interop/react-factory GridOffTwoTone))
(def grid-on (interop/react-factory GridOn))
(def grid-on-outlined (interop/react-factory GridOnOutlined))
(def grid-on-rounded (interop/react-factory GridOnRounded))
(def grid-on-sharp (interop/react-factory GridOnSharp))
(def grid-on-two-tone (interop/react-factory GridOnTwoTone))
(def group (interop/react-factory Group))
(def group-add (interop/react-factory GroupAdd))
(def group-add-outlined (interop/react-factory GroupAddOutlined))
(def group-add-rounded (interop/react-factory GroupAddRounded))
(def group-add-sharp (interop/react-factory GroupAddSharp))
(def group-add-two-tone (interop/react-factory GroupAddTwoTone))
(def group-outlined (interop/react-factory GroupOutlined))
(def group-rounded (interop/react-factory GroupRounded))
(def group-sharp (interop/react-factory GroupSharp))
(def group-two-tone (interop/react-factory GroupTwoTone))
(def group-work (interop/react-factory GroupWork))
(def group-work-outlined (interop/react-factory GroupWorkOutlined))
(def group-work-rounded (interop/react-factory GroupWorkRounded))
(def group-work-sharp (interop/react-factory GroupWorkSharp))
(def group-work-two-tone (interop/react-factory GroupWorkTwoTone))
(def g-translate (interop/react-factory GTranslate))
(def g-translate-outlined (interop/react-factory GTranslateOutlined))
(def g-translate-rounded (interop/react-factory GTranslateRounded))
(def g-translate-sharp (interop/react-factory GTranslateSharp))
(def g-translate-two-tone (interop/react-factory GTranslateTwoTone))
(def hd (interop/react-factory Hd))
(def hd-outlined (interop/react-factory HdOutlined))
(def hdr-off (interop/react-factory HdrOff))
(def hdr-off-outlined (interop/react-factory HdrOffOutlined))
(def hdr-off-rounded (interop/react-factory HdrOffRounded))
(def hdr-off-sharp (interop/react-factory HdrOffSharp))
(def hdr-off-two-tone (interop/react-factory HdrOffTwoTone))
(def hdr-on (interop/react-factory HdrOn))
(def hdr-on-outlined (interop/react-factory HdrOnOutlined))
(def hdr-on-rounded (interop/react-factory HdrOnRounded))
(def hdr-on-sharp (interop/react-factory HdrOnSharp))
(def hdr-on-two-tone (interop/react-factory HdrOnTwoTone))
(def hd-rounded (interop/react-factory HdRounded))
(def hdr-strong (interop/react-factory HdrStrong))
(def hdr-strong-outlined (interop/react-factory HdrStrongOutlined))
(def hdr-strong-rounded (interop/react-factory HdrStrongRounded))
(def hdr-strong-sharp (interop/react-factory HdrStrongSharp))
(def hdr-strong-two-tone (interop/react-factory HdrStrongTwoTone))
(def hdr-weak (interop/react-factory HdrWeak))
(def hdr-weak-outlined (interop/react-factory HdrWeakOutlined))
(def hdr-weak-rounded (interop/react-factory HdrWeakRounded))
(def hdr-weak-sharp (interop/react-factory HdrWeakSharp))
(def hdr-weak-two-tone (interop/react-factory HdrWeakTwoTone))
(def hd-sharp (interop/react-factory HdSharp))
(def hd-two-tone (interop/react-factory HdTwoTone))
(def headset (interop/react-factory Headset))
(def headset-mic (interop/react-factory HeadsetMic))
(def headset-mic-outlined (interop/react-factory HeadsetMicOutlined))
(def headset-mic-rounded (interop/react-factory HeadsetMicRounded))
(def headset-mic-sharp (interop/react-factory HeadsetMicSharp))
(def headset-mic-two-tone (interop/react-factory HeadsetMicTwoTone))
(def headset-outlined (interop/react-factory HeadsetOutlined))
(def headset-rounded (interop/react-factory HeadsetRounded))
(def headset-sharp (interop/react-factory HeadsetSharp))
(def headset-two-tone (interop/react-factory HeadsetTwoTone))
(def healing (interop/react-factory Healing))
(def healing-outlined (interop/react-factory HealingOutlined))
(def healing-rounded (interop/react-factory HealingRounded))
(def healing-sharp (interop/react-factory HealingSharp))
(def healing-two-tone (interop/react-factory HealingTwoTone))
(def hearing (interop/react-factory Hearing))
(def hearing-outlined (interop/react-factory HearingOutlined))
(def hearing-rounded (interop/react-factory HearingRounded))
(def hearing-sharp (interop/react-factory HearingSharp))
(def hearing-two-tone (interop/react-factory HearingTwoTone))
(def height (interop/react-factory Height))
(def height-outlined (interop/react-factory HeightOutlined))
(def height-rounded (interop/react-factory HeightRounded))
(def height-sharp (interop/react-factory HeightSharp))
(def height-two-tone (interop/react-factory HeightTwoTone))
(def help (interop/react-factory Help))
(def help-outline (interop/react-factory HelpOutline))
(def help-outlined (interop/react-factory HelpOutlined))
(def help-outline-outlined (interop/react-factory HelpOutlineOutlined))
(def help-outline-rounded (interop/react-factory HelpOutlineRounded))
(def help-outline-sharp (interop/react-factory HelpOutlineSharp))
(def help-outline-two-tone (interop/react-factory HelpOutlineTwoTone))
(def help-rounded (interop/react-factory HelpRounded))
(def help-sharp (interop/react-factory HelpSharp))
(def help-two-tone (interop/react-factory HelpTwoTone))
(def highlight (interop/react-factory Highlight))
(def highlight-off (interop/react-factory HighlightOff))
(def highlight-off-outlined (interop/react-factory HighlightOffOutlined))
(def highlight-off-rounded (interop/react-factory HighlightOffRounded))
(def highlight-off-sharp (interop/react-factory HighlightOffSharp))
(def highlight-off-two-tone (interop/react-factory HighlightOffTwoTone))
(def highlight-outlined (interop/react-factory HighlightOutlined))
(def highlight-rounded (interop/react-factory HighlightRounded))
(def highlight-sharp (interop/react-factory HighlightSharp))
(def highlight-two-tone (interop/react-factory HighlightTwoTone))
(def high-quality (interop/react-factory HighQuality))
(def high-quality-outlined (interop/react-factory HighQualityOutlined))
(def high-quality-rounded (interop/react-factory HighQualityRounded))
(def high-quality-sharp (interop/react-factory HighQualitySharp))
(def high-quality-two-tone (interop/react-factory HighQualityTwoTone))
(def history (interop/react-factory History))
(def history-outlined (interop/react-factory HistoryOutlined))
(def history-rounded (interop/react-factory HistoryRounded))
(def history-sharp (interop/react-factory HistorySharp))
(def history-two-tone (interop/react-factory HistoryTwoTone))
(def home (interop/react-factory Home))
(def home-outlined (interop/react-factory HomeOutlined))
(def home-rounded (interop/react-factory HomeRounded))
(def home-sharp (interop/react-factory HomeSharp))
(def home-two-tone (interop/react-factory HomeTwoTone))
(def home-work (interop/react-factory HomeWork))
(def home-work-outlined (interop/react-factory HomeWorkOutlined))
(def home-work-rounded (interop/react-factory HomeWorkRounded))
(def home-work-sharp (interop/react-factory HomeWorkSharp))
(def home-work-two-tone (interop/react-factory HomeWorkTwoTone))
(def horizontal-split (interop/react-factory HorizontalSplit))
(def horizontal-split-outlined (interop/react-factory HorizontalSplitOutlined))
(def horizontal-split-rounded (interop/react-factory HorizontalSplitRounded))
(def horizontal-split-sharp (interop/react-factory HorizontalSplitSharp))
(def horizontal-split-two-tone (interop/react-factory HorizontalSplitTwoTone))
(def hotel (interop/react-factory Hotel))
(def hotel-outlined (interop/react-factory HotelOutlined))
(def hotel-rounded (interop/react-factory HotelRounded))
(def hotel-sharp (interop/react-factory HotelSharp))
(def hotel-two-tone (interop/react-factory HotelTwoTone))
(def hot-tub (interop/react-factory HotTub))
(def hot-tub-outlined (interop/react-factory HotTubOutlined))
(def hot-tub-rounded (interop/react-factory HotTubRounded))
(def hot-tub-sharp (interop/react-factory HotTubSharp))
(def hot-tub-two-tone (interop/react-factory HotTubTwoTone))
(def hourglass-empty (interop/react-factory HourglassEmpty))
(def hourglass-empty-outlined (interop/react-factory HourglassEmptyOutlined))
(def hourglass-empty-rounded (interop/react-factory HourglassEmptyRounded))
(def hourglass-empty-sharp (interop/react-factory HourglassEmptySharp))
(def hourglass-empty-two-tone (interop/react-factory HourglassEmptyTwoTone))
(def hourglass-full (interop/react-factory HourglassFull))
(def hourglass-full-outlined (interop/react-factory HourglassFullOutlined))
(def hourglass-full-rounded (interop/react-factory HourglassFullRounded))
(def hourglass-full-sharp (interop/react-factory HourglassFullSharp))
(def hourglass-full-two-tone (interop/react-factory HourglassFullTwoTone))
(def house (interop/react-factory House))
(def house-outlined (interop/react-factory HouseOutlined))
(def house-rounded (interop/react-factory HouseRounded))
(def house-sharp (interop/react-factory HouseSharp))
(def house-two-tone (interop/react-factory HouseTwoTone))
(def how-to-reg (interop/react-factory HowToReg))
(def how-to-reg-outlined (interop/react-factory HowToRegOutlined))
(def how-to-reg-rounded (interop/react-factory HowToRegRounded))
(def how-to-reg-sharp (interop/react-factory HowToRegSharp))
(def how-to-reg-two-tone (interop/react-factory HowToRegTwoTone))
(def how-to-vote (interop/react-factory HowToVote))
(def how-to-vote-outlined (interop/react-factory HowToVoteOutlined))
(def how-to-vote-rounded (interop/react-factory HowToVoteRounded))
(def how-to-vote-sharp (interop/react-factory HowToVoteSharp))
(def how-to-vote-two-tone (interop/react-factory HowToVoteTwoTone))
(def http (interop/react-factory Http))
(def http-outlined (interop/react-factory HttpOutlined))
(def http-rounded (interop/react-factory HttpRounded))
(def https (interop/react-factory Https))
(def http-sharp (interop/react-factory HttpSharp))
(def https-outlined (interop/react-factory HttpsOutlined))
(def https-rounded (interop/react-factory HttpsRounded))
(def https-sharp (interop/react-factory HttpsSharp))
(def https-two-tone (interop/react-factory HttpsTwoTone))
(def http-two-tone (interop/react-factory HttpTwoTone))
(def image (interop/react-factory Image))
(def image-aspect-ratio (interop/react-factory ImageAspectRatio))
(def image-aspect-ratio-outlined (interop/react-factory ImageAspectRatioOutlined))
(def image-aspect-ratio-rounded (interop/react-factory ImageAspectRatioRounded))
(def image-aspect-ratio-sharp (interop/react-factory ImageAspectRatioSharp))
(def image-aspect-ratio-two-tone (interop/react-factory ImageAspectRatioTwoTone))
(def image-outlined (interop/react-factory ImageOutlined))
(def image-rounded (interop/react-factory ImageRounded))
(def image-search (interop/react-factory ImageSearch))
(def image-search-outlined (interop/react-factory ImageSearchOutlined))
(def image-search-rounded (interop/react-factory ImageSearchRounded))
(def image-search-sharp (interop/react-factory ImageSearchSharp))
(def image-search-two-tone (interop/react-factory ImageSearchTwoTone))
(def image-sharp (interop/react-factory ImageSharp))
(def image-two-tone (interop/react-factory ImageTwoTone))
(def important-devices (interop/react-factory ImportantDevices))
(def important-devices-outlined (interop/react-factory ImportantDevicesOutlined))
(def important-devices-rounded (interop/react-factory ImportantDevicesRounded))
(def important-devices-sharp (interop/react-factory ImportantDevicesSharp))
(def important-devices-two-tone (interop/react-factory ImportantDevicesTwoTone))
(def import-contacts (interop/react-factory ImportContacts))
(def import-contacts-outlined (interop/react-factory ImportContactsOutlined))
(def import-contacts-rounded (interop/react-factory ImportContactsRounded))
(def import-contacts-sharp (interop/react-factory ImportContactsSharp))
(def import-contacts-two-tone (interop/react-factory ImportContactsTwoTone))
(def import-export (interop/react-factory ImportExport))
(def import-export-outlined (interop/react-factory ImportExportOutlined))
(def import-export-rounded (interop/react-factory ImportExportRounded))
(def import-export-sharp (interop/react-factory ImportExportSharp))
(def import-export-two-tone (interop/react-factory ImportExportTwoTone))
(def inbox (interop/react-factory Inbox))
(def inbox-outlined (interop/react-factory InboxOutlined))
(def inbox-rounded (interop/react-factory InboxRounded))
(def inbox-sharp (interop/react-factory InboxSharp))
(def inbox-two-tone (interop/react-factory InboxTwoTone))
(def indeterminate-check-box (interop/react-factory IndeterminateCheckBox))
(def indeterminate-check-box-outlined (interop/react-factory IndeterminateCheckBoxOutlined))
(def indeterminate-check-box-rounded (interop/react-factory IndeterminateCheckBoxRounded))
(def indeterminate-check-box-sharp (interop/react-factory IndeterminateCheckBoxSharp))
(def indeterminate-check-box-two-tone (interop/react-factory IndeterminateCheckBoxTwoTone))
(def info (interop/react-factory Info))
(def info-outlined (interop/react-factory InfoOutlined))
(def info-rounded (interop/react-factory InfoRounded))
(def info-sharp (interop/react-factory InfoSharp))
(def info-two-tone (interop/react-factory InfoTwoTone))
(def input (interop/react-factory Input))
(def input-outlined (interop/react-factory InputOutlined))
(def input-rounded (interop/react-factory InputRounded))
(def input-sharp (interop/react-factory InputSharp))
(def input-two-tone (interop/react-factory InputTwoTone))
(def insert-chart (interop/react-factory InsertChart))
(def insert-chart-outlined (interop/react-factory InsertChartOutlined))
(def insert-chart-outlined-outlined (interop/react-factory InsertChartOutlinedOutlined))
(def insert-chart-outlined-rounded (interop/react-factory InsertChartOutlinedRounded))
(def insert-chart-outlined-sharp (interop/react-factory InsertChartOutlinedSharp))
(def insert-chart-outlined-two-tone (interop/react-factory InsertChartOutlinedTwoTone))
(def insert-chart-rounded (interop/react-factory InsertChartRounded))
(def insert-chart-sharp (interop/react-factory InsertChartSharp))
(def insert-chart-two-tone (interop/react-factory InsertChartTwoTone))
(def insert-comment (interop/react-factory InsertComment))
(def insert-comment-outlined (interop/react-factory InsertCommentOutlined))
(def insert-comment-rounded (interop/react-factory InsertCommentRounded))
(def insert-comment-sharp (interop/react-factory InsertCommentSharp))
(def insert-comment-two-tone (interop/react-factory InsertCommentTwoTone))
(def insert-drive-file (interop/react-factory InsertDriveFile))
(def insert-drive-file-outlined (interop/react-factory InsertDriveFileOutlined))
(def insert-drive-file-rounded (interop/react-factory InsertDriveFileRounded))
(def insert-drive-file-sharp (interop/react-factory InsertDriveFileSharp))
(def insert-drive-file-two-tone (interop/react-factory InsertDriveFileTwoTone))
(def insert-emoticon (interop/react-factory InsertEmoticon))
(def insert-emoticon-outlined (interop/react-factory InsertEmoticonOutlined))
(def insert-emoticon-rounded (interop/react-factory InsertEmoticonRounded))
(def insert-emoticon-sharp (interop/react-factory InsertEmoticonSharp))
(def insert-emoticon-two-tone (interop/react-factory InsertEmoticonTwoTone))
(def insert-invitation (interop/react-factory InsertInvitation))
(def insert-invitation-outlined (interop/react-factory InsertInvitationOutlined))
(def insert-invitation-rounded (interop/react-factory InsertInvitationRounded))
(def insert-invitation-sharp (interop/react-factory InsertInvitationSharp))
(def insert-invitation-two-tone (interop/react-factory InsertInvitationTwoTone))
(def insert-link (interop/react-factory InsertLink))
(def insert-link-outlined (interop/react-factory InsertLinkOutlined))
(def insert-link-rounded (interop/react-factory InsertLinkRounded))
(def insert-link-sharp (interop/react-factory InsertLinkSharp))
(def insert-link-two-tone (interop/react-factory InsertLinkTwoTone))
(def insert-photo (interop/react-factory InsertPhoto))
(def insert-photo-outlined (interop/react-factory InsertPhotoOutlined))
(def insert-photo-rounded (interop/react-factory InsertPhotoRounded))
(def insert-photo-sharp (interop/react-factory InsertPhotoSharp))
(def insert-photo-two-tone (interop/react-factory InsertPhotoTwoTone))
(def instagram (interop/react-factory Instagram))
(def invert-colors (interop/react-factory InvertColors))
(def invert-colors-off (interop/react-factory InvertColorsOff))
(def invert-colors-off-outlined (interop/react-factory InvertColorsOffOutlined))
(def invert-colors-off-rounded (interop/react-factory InvertColorsOffRounded))
(def invert-colors-off-sharp (interop/react-factory InvertColorsOffSharp))
(def invert-colors-off-two-tone (interop/react-factory InvertColorsOffTwoTone))
(def invert-colors-outlined (interop/react-factory InvertColorsOutlined))
(def invert-colors-rounded (interop/react-factory InvertColorsRounded))
(def invert-colors-sharp (interop/react-factory InvertColorsSharp))
(def invert-colors-two-tone (interop/react-factory InvertColorsTwoTone))
(def iso (interop/react-factory Iso))
(def iso-outlined (interop/react-factory IsoOutlined))
(def iso-rounded (interop/react-factory IsoRounded))
(def iso-sharp (interop/react-factory IsoSharp))
(def iso-two-tone (interop/react-factory IsoTwoTone))
(def keyboard (interop/react-factory Keyboard))
(def keyboard-arrow-down (interop/react-factory KeyboardArrowDown))
(def keyboard-arrow-down-outlined (interop/react-factory KeyboardArrowDownOutlined))
(def keyboard-arrow-down-rounded (interop/react-factory KeyboardArrowDownRounded))
(def keyboard-arrow-down-sharp (interop/react-factory KeyboardArrowDownSharp))
(def keyboard-arrow-down-two-tone (interop/react-factory KeyboardArrowDownTwoTone))
(def keyboard-arrow-left (interop/react-factory KeyboardArrowLeft))
(def keyboard-arrow-left-outlined (interop/react-factory KeyboardArrowLeftOutlined))
(def keyboard-arrow-left-rounded (interop/react-factory KeyboardArrowLeftRounded))
(def keyboard-arrow-left-sharp (interop/react-factory KeyboardArrowLeftSharp))
(def keyboard-arrow-left-two-tone (interop/react-factory KeyboardArrowLeftTwoTone))
(def keyboard-arrow-right (interop/react-factory KeyboardArrowRight))
(def keyboard-arrow-right-outlined (interop/react-factory KeyboardArrowRightOutlined))
(def keyboard-arrow-right-rounded (interop/react-factory KeyboardArrowRightRounded))
(def keyboard-arrow-right-sharp (interop/react-factory KeyboardArrowRightSharp))
(def keyboard-arrow-right-two-tone (interop/react-factory KeyboardArrowRightTwoTone))
(def keyboard-arrow-up (interop/react-factory KeyboardArrowUp))
(def keyboard-arrow-up-outlined (interop/react-factory KeyboardArrowUpOutlined))
(def keyboard-arrow-up-rounded (interop/react-factory KeyboardArrowUpRounded))
(def keyboard-arrow-up-sharp (interop/react-factory KeyboardArrowUpSharp))
(def keyboard-arrow-up-two-tone (interop/react-factory KeyboardArrowUpTwoTone))
(def keyboard-backspace (interop/react-factory KeyboardBackspace))
(def keyboard-backspace-outlined (interop/react-factory KeyboardBackspaceOutlined))
(def keyboard-backspace-rounded (interop/react-factory KeyboardBackspaceRounded))
(def keyboard-backspace-sharp (interop/react-factory KeyboardBackspaceSharp))
(def keyboard-backspace-two-tone (interop/react-factory KeyboardBackspaceTwoTone))
(def keyboard-capslock (interop/react-factory KeyboardCapslock))
(def keyboard-capslock-outlined (interop/react-factory KeyboardCapslockOutlined))
(def keyboard-capslock-rounded (interop/react-factory KeyboardCapslockRounded))
(def keyboard-capslock-sharp (interop/react-factory KeyboardCapslockSharp))
(def keyboard-capslock-two-tone (interop/react-factory KeyboardCapslockTwoTone))
(def keyboard-hide (interop/react-factory KeyboardHide))
(def keyboard-hide-outlined (interop/react-factory KeyboardHideOutlined))
(def keyboard-hide-rounded (interop/react-factory KeyboardHideRounded))
(def keyboard-hide-sharp (interop/react-factory KeyboardHideSharp))
(def keyboard-hide-two-tone (interop/react-factory KeyboardHideTwoTone))
(def keyboard-outlined (interop/react-factory KeyboardOutlined))
(def keyboard-return (interop/react-factory KeyboardReturn))
(def keyboard-return-outlined (interop/react-factory KeyboardReturnOutlined))
(def keyboard-return-rounded (interop/react-factory KeyboardReturnRounded))
(def keyboard-return-sharp (interop/react-factory KeyboardReturnSharp))
(def keyboard-return-two-tone (interop/react-factory KeyboardReturnTwoTone))
(def keyboard-rounded (interop/react-factory KeyboardRounded))
(def keyboard-sharp (interop/react-factory KeyboardSharp))
(def keyboard-tab (interop/react-factory KeyboardTab))
(def keyboard-tab-outlined (interop/react-factory KeyboardTabOutlined))
(def keyboard-tab-rounded (interop/react-factory KeyboardTabRounded))
(def keyboard-tab-sharp (interop/react-factory KeyboardTabSharp))
(def keyboard-tab-two-tone (interop/react-factory KeyboardTabTwoTone))
(def keyboard-two-tone (interop/react-factory KeyboardTwoTone))
(def keyboard-voice (interop/react-factory KeyboardVoice))
(def keyboard-voice-outlined (interop/react-factory KeyboardVoiceOutlined))
(def keyboard-voice-rounded (interop/react-factory KeyboardVoiceRounded))
(def keyboard-voice-sharp (interop/react-factory KeyboardVoiceSharp))
(def keyboard-voice-two-tone (interop/react-factory KeyboardVoiceTwoTone))
(def king-bed (interop/react-factory KingBed))
(def king-bed-outlined (interop/react-factory KingBedOutlined))
(def king-bed-rounded (interop/react-factory KingBedRounded))
(def king-bed-sharp (interop/react-factory KingBedSharp))
(def king-bed-two-tone (interop/react-factory KingBedTwoTone))
(def kitchen (interop/react-factory Kitchen))
(def kitchen-outlined (interop/react-factory KitchenOutlined))
(def kitchen-rounded (interop/react-factory KitchenRounded))
(def kitchen-sharp (interop/react-factory KitchenSharp))
(def kitchen-two-tone (interop/react-factory KitchenTwoTone))
(def label (interop/react-factory Label))
(def label-important (interop/react-factory LabelImportant))
(def label-important-outlined (interop/react-factory LabelImportantOutlined))
(def label-important-rounded (interop/react-factory LabelImportantRounded))
(def label-important-sharp (interop/react-factory LabelImportantSharp))
(def label-important-two-tone (interop/react-factory LabelImportantTwoTone))
(def label-off (interop/react-factory LabelOff))
(def label-off-outlined (interop/react-factory LabelOffOutlined))
(def label-off-rounded (interop/react-factory LabelOffRounded))
(def label-off-sharp (interop/react-factory LabelOffSharp))
(def label-off-two-tone (interop/react-factory LabelOffTwoTone))
(def label-outlined (interop/react-factory LabelOutlined))
(def label-rounded (interop/react-factory LabelRounded))
(def label-sharp (interop/react-factory LabelSharp))
(def label-two-tone (interop/react-factory LabelTwoTone))
(def landscape (interop/react-factory Landscape))
(def landscape-outlined (interop/react-factory LandscapeOutlined))
(def landscape-rounded (interop/react-factory LandscapeRounded))
(def landscape-sharp (interop/react-factory LandscapeSharp))
(def landscape-two-tone (interop/react-factory LandscapeTwoTone))
(def language (interop/react-factory Language))
(def language-outlined (interop/react-factory LanguageOutlined))
(def language-rounded (interop/react-factory LanguageRounded))
(def language-sharp (interop/react-factory LanguageSharp))
(def language-two-tone (interop/react-factory LanguageTwoTone))
(def laptop (interop/react-factory Laptop))
(def laptop-chromebook (interop/react-factory LaptopChromebook))
(def laptop-chromebook-outlined (interop/react-factory LaptopChromebookOutlined))
(def laptop-chromebook-rounded (interop/react-factory LaptopChromebookRounded))
(def laptop-chromebook-sharp (interop/react-factory LaptopChromebookSharp))
(def laptop-chromebook-two-tone (interop/react-factory LaptopChromebookTwoTone))
(def laptop-mac (interop/react-factory LaptopMac))
(def laptop-mac-outlined (interop/react-factory LaptopMacOutlined))
(def laptop-mac-rounded (interop/react-factory LaptopMacRounded))
(def laptop-mac-sharp (interop/react-factory LaptopMacSharp))
(def laptop-mac-two-tone (interop/react-factory LaptopMacTwoTone))
(def laptop-outlined (interop/react-factory LaptopOutlined))
(def laptop-rounded (interop/react-factory LaptopRounded))
(def laptop-sharp (interop/react-factory LaptopSharp))
(def laptop-two-tone (interop/react-factory LaptopTwoTone))
(def laptop-windows (interop/react-factory LaptopWindows))
(def laptop-windows-outlined (interop/react-factory LaptopWindowsOutlined))
(def laptop-windows-rounded (interop/react-factory LaptopWindowsRounded))
(def laptop-windows-sharp (interop/react-factory LaptopWindowsSharp))
(def laptop-windows-two-tone (interop/react-factory LaptopWindowsTwoTone))
(def last-page (interop/react-factory LastPage))
(def last-page-outlined (interop/react-factory LastPageOutlined))
(def last-page-rounded (interop/react-factory LastPageRounded))
(def last-page-sharp (interop/react-factory LastPageSharp))
(def last-page-two-tone (interop/react-factory LastPageTwoTone))
(def launch (interop/react-factory Launch))
(def launch-outlined (interop/react-factory LaunchOutlined))
(def launch-rounded (interop/react-factory LaunchRounded))
(def launch-sharp (interop/react-factory LaunchSharp))
(def launch-two-tone (interop/react-factory LaunchTwoTone))
(def layers (interop/react-factory Layers))
(def layers-clear (interop/react-factory LayersClear))
(def layers-clear-outlined (interop/react-factory LayersClearOutlined))
(def layers-clear-rounded (interop/react-factory LayersClearRounded))
(def layers-clear-sharp (interop/react-factory LayersClearSharp))
(def layers-clear-two-tone (interop/react-factory LayersClearTwoTone))
(def layers-outlined (interop/react-factory LayersOutlined))
(def layers-rounded (interop/react-factory LayersRounded))
(def layers-sharp (interop/react-factory LayersSharp))
(def layers-two-tone (interop/react-factory LayersTwoTone))
(def leak-add (interop/react-factory LeakAdd))
(def leak-add-outlined (interop/react-factory LeakAddOutlined))
(def leak-add-rounded (interop/react-factory LeakAddRounded))
(def leak-add-sharp (interop/react-factory LeakAddSharp))
(def leak-add-two-tone (interop/react-factory LeakAddTwoTone))
(def leak-remove (interop/react-factory LeakRemove))
(def leak-remove-outlined (interop/react-factory LeakRemoveOutlined))
(def leak-remove-rounded (interop/react-factory LeakRemoveRounded))
(def leak-remove-sharp (interop/react-factory LeakRemoveSharp))
(def leak-remove-two-tone (interop/react-factory LeakRemoveTwoTone))
(def lens (interop/react-factory Lens))
(def lens-outlined (interop/react-factory LensOutlined))
(def lens-rounded (interop/react-factory LensRounded))
(def lens-sharp (interop/react-factory LensSharp))
(def lens-two-tone (interop/react-factory LensTwoTone))
(def library-add (interop/react-factory LibraryAdd))
(def library-add-check (interop/react-factory LibraryAddCheck))
(def library-add-check-outlined (interop/react-factory LibraryAddCheckOutlined))
(def library-add-check-rounded (interop/react-factory LibraryAddCheckRounded))
(def library-add-check-sharp (interop/react-factory LibraryAddCheckSharp))
(def library-add-check-two-tone (interop/react-factory LibraryAddCheckTwoTone))
(def library-add-outlined (interop/react-factory LibraryAddOutlined))
(def library-add-rounded (interop/react-factory LibraryAddRounded))
(def library-add-sharp (interop/react-factory LibraryAddSharp))
(def library-add-two-tone (interop/react-factory LibraryAddTwoTone))
(def library-books (interop/react-factory LibraryBooks))
(def library-books-outlined (interop/react-factory LibraryBooksOutlined))
(def library-books-rounded (interop/react-factory LibraryBooksRounded))
(def library-books-sharp (interop/react-factory LibraryBooksSharp))
(def library-books-two-tone (interop/react-factory LibraryBooksTwoTone))
(def library-music (interop/react-factory LibraryMusic))
(def library-music-outlined (interop/react-factory LibraryMusicOutlined))
(def library-music-rounded (interop/react-factory LibraryMusicRounded))
(def library-music-sharp (interop/react-factory LibraryMusicSharp))
(def library-music-two-tone (interop/react-factory LibraryMusicTwoTone))
(def linear-scale (interop/react-factory LinearScale))
(def linear-scale-outlined (interop/react-factory LinearScaleOutlined))
(def linear-scale-rounded (interop/react-factory LinearScaleRounded))
(def linear-scale-sharp (interop/react-factory LinearScaleSharp))
(def linear-scale-two-tone (interop/react-factory LinearScaleTwoTone))
(def line-style (interop/react-factory LineStyle))
(def line-style-outlined (interop/react-factory LineStyleOutlined))
(def line-style-rounded (interop/react-factory LineStyleRounded))
(def line-style-sharp (interop/react-factory LineStyleSharp))
(def line-style-two-tone (interop/react-factory LineStyleTwoTone))
(def line-weight (interop/react-factory LineWeight))
(def line-weight-outlined (interop/react-factory LineWeightOutlined))
(def line-weight-rounded (interop/react-factory LineWeightRounded))
(def line-weight-sharp (interop/react-factory LineWeightSharp))
(def line-weight-two-tone (interop/react-factory LineWeightTwoTone))
(def link (interop/react-factory Link))
(def linked-camera (interop/react-factory LinkedCamera))
(def linked-camera-outlined (interop/react-factory LinkedCameraOutlined))
(def linked-camera-rounded (interop/react-factory LinkedCameraRounded))
(def linked-camera-sharp (interop/react-factory LinkedCameraSharp))
(def linked-camera-two-tone (interop/react-factory LinkedCameraTwoTone))
(def linked-in (interop/react-factory LinkedIn))
(def link-off (interop/react-factory LinkOff))
(def link-off-outlined (interop/react-factory LinkOffOutlined))
(def link-off-rounded (interop/react-factory LinkOffRounded))
(def link-off-sharp (interop/react-factory LinkOffSharp))
(def link-off-two-tone (interop/react-factory LinkOffTwoTone))
(def link-outlined (interop/react-factory LinkOutlined))
(def link-rounded (interop/react-factory LinkRounded))
(def link-sharp (interop/react-factory LinkSharp))
(def link-two-tone (interop/react-factory LinkTwoTone))
(def list (interop/react-factory List))
(def list-alt (interop/react-factory ListAlt))
(def list-alt-outlined (interop/react-factory ListAltOutlined))
(def list-alt-rounded (interop/react-factory ListAltRounded))
(def list-alt-sharp (interop/react-factory ListAltSharp))
(def list-alt-two-tone (interop/react-factory ListAltTwoTone))
(def list-outlined (interop/react-factory ListOutlined))
(def list-rounded (interop/react-factory ListRounded))
(def list-sharp (interop/react-factory ListSharp))
(def list-two-tone (interop/react-factory ListTwoTone))
(def live-help (interop/react-factory LiveHelp))
(def live-help-outlined (interop/react-factory LiveHelpOutlined))
(def live-help-rounded (interop/react-factory LiveHelpRounded))
(def live-help-sharp (interop/react-factory LiveHelpSharp))
(def live-help-two-tone (interop/react-factory LiveHelpTwoTone))
(def live-tv (interop/react-factory LiveTv))
(def live-tv-outlined (interop/react-factory LiveTvOutlined))
(def live-tv-rounded (interop/react-factory LiveTvRounded))
(def live-tv-sharp (interop/react-factory LiveTvSharp))
(def live-tv-two-tone (interop/react-factory LiveTvTwoTone))
(def local-activity (interop/react-factory LocalActivity))
(def local-activity-outlined (interop/react-factory LocalActivityOutlined))
(def local-activity-rounded (interop/react-factory LocalActivityRounded))
(def local-activity-sharp (interop/react-factory LocalActivitySharp))
(def local-activity-two-tone (interop/react-factory LocalActivityTwoTone))
(def local-airport (interop/react-factory LocalAirport))
(def local-airport-outlined (interop/react-factory LocalAirportOutlined))
(def local-airport-rounded (interop/react-factory LocalAirportRounded))
(def local-airport-sharp (interop/react-factory LocalAirportSharp))
(def local-airport-two-tone (interop/react-factory LocalAirportTwoTone))
(def local-atm (interop/react-factory LocalAtm))
(def local-atm-outlined (interop/react-factory LocalAtmOutlined))
(def local-atm-rounded (interop/react-factory LocalAtmRounded))
(def local-atm-sharp (interop/react-factory LocalAtmSharp))
(def local-atm-two-tone (interop/react-factory LocalAtmTwoTone))
(def local-bar (interop/react-factory LocalBar))
(def local-bar-outlined (interop/react-factory LocalBarOutlined))
(def local-bar-rounded (interop/react-factory LocalBarRounded))
(def local-bar-sharp (interop/react-factory LocalBarSharp))
(def local-bar-two-tone (interop/react-factory LocalBarTwoTone))
(def local-cafe (interop/react-factory LocalCafe))
(def local-cafe-outlined (interop/react-factory LocalCafeOutlined))
(def local-cafe-rounded (interop/react-factory LocalCafeRounded))
(def local-cafe-sharp (interop/react-factory LocalCafeSharp))
(def local-cafe-two-tone (interop/react-factory LocalCafeTwoTone))
(def local-car-wash (interop/react-factory LocalCarWash))
(def local-car-wash-outlined (interop/react-factory LocalCarWashOutlined))
(def local-car-wash-rounded (interop/react-factory LocalCarWashRounded))
(def local-car-wash-sharp (interop/react-factory LocalCarWashSharp))
(def local-car-wash-two-tone (interop/react-factory LocalCarWashTwoTone))
(def local-convenience-store (interop/react-factory LocalConvenienceStore))
(def local-convenience-store-outlined (interop/react-factory LocalConvenienceStoreOutlined))
(def local-convenience-store-rounded (interop/react-factory LocalConvenienceStoreRounded))
(def local-convenience-store-sharp (interop/react-factory LocalConvenienceStoreSharp))
(def local-convenience-store-two-tone (interop/react-factory LocalConvenienceStoreTwoTone))
(def local-dining (interop/react-factory LocalDining))
(def local-dining-outlined (interop/react-factory LocalDiningOutlined))
(def local-dining-rounded (interop/react-factory LocalDiningRounded))
(def local-dining-sharp (interop/react-factory LocalDiningSharp))
(def local-dining-two-tone (interop/react-factory LocalDiningTwoTone))
(def local-drink (interop/react-factory LocalDrink))
(def local-drink-outlined (interop/react-factory LocalDrinkOutlined))
(def local-drink-rounded (interop/react-factory LocalDrinkRounded))
(def local-drink-sharp (interop/react-factory LocalDrinkSharp))
(def local-drink-two-tone (interop/react-factory LocalDrinkTwoTone))
(def local-florist (interop/react-factory LocalFlorist))
(def local-florist-outlined (interop/react-factory LocalFloristOutlined))
(def local-florist-rounded (interop/react-factory LocalFloristRounded))
(def local-florist-sharp (interop/react-factory LocalFloristSharp))
(def local-florist-two-tone (interop/react-factory LocalFloristTwoTone))
(def local-gas-station (interop/react-factory LocalGasStation))
(def local-gas-station-outlined (interop/react-factory LocalGasStationOutlined))
(def local-gas-station-rounded (interop/react-factory LocalGasStationRounded))
(def local-gas-station-sharp (interop/react-factory LocalGasStationSharp))
(def local-gas-station-two-tone (interop/react-factory LocalGasStationTwoTone))
(def local-grocery-store (interop/react-factory LocalGroceryStore))
(def local-grocery-store-outlined (interop/react-factory LocalGroceryStoreOutlined))
(def local-grocery-store-rounded (interop/react-factory LocalGroceryStoreRounded))
(def local-grocery-store-sharp (interop/react-factory LocalGroceryStoreSharp))
(def local-grocery-store-two-tone (interop/react-factory LocalGroceryStoreTwoTone))
(def local-hospital (interop/react-factory LocalHospital))
(def local-hospital-outlined (interop/react-factory LocalHospitalOutlined))
(def local-hospital-rounded (interop/react-factory LocalHospitalRounded))
(def local-hospital-sharp (interop/react-factory LocalHospitalSharp))
(def local-hospital-two-tone (interop/react-factory LocalHospitalTwoTone))
(def local-hotel (interop/react-factory LocalHotel))
(def local-hotel-outlined (interop/react-factory LocalHotelOutlined))
(def local-hotel-rounded (interop/react-factory LocalHotelRounded))
(def local-hotel-sharp (interop/react-factory LocalHotelSharp))
(def local-hotel-two-tone (interop/react-factory LocalHotelTwoTone))
(def local-laundry-service (interop/react-factory LocalLaundryService))
(def local-laundry-service-outlined (interop/react-factory LocalLaundryServiceOutlined))
(def local-laundry-service-rounded (interop/react-factory LocalLaundryServiceRounded))
(def local-laundry-service-sharp (interop/react-factory LocalLaundryServiceSharp))
(def local-laundry-service-two-tone (interop/react-factory LocalLaundryServiceTwoTone))
(def local-library (interop/react-factory LocalLibrary))
(def local-library-outlined (interop/react-factory LocalLibraryOutlined))
(def local-library-rounded (interop/react-factory LocalLibraryRounded))
(def local-library-sharp (interop/react-factory LocalLibrarySharp))
(def local-library-two-tone (interop/react-factory LocalLibraryTwoTone))
(def local-mall (interop/react-factory LocalMall))
(def local-mall-outlined (interop/react-factory LocalMallOutlined))
(def local-mall-rounded (interop/react-factory LocalMallRounded))
(def local-mall-sharp (interop/react-factory LocalMallSharp))
(def local-mall-two-tone (interop/react-factory LocalMallTwoTone))
(def local-movies (interop/react-factory LocalMovies))
(def local-movies-outlined (interop/react-factory LocalMoviesOutlined))
(def local-movies-rounded (interop/react-factory LocalMoviesRounded))
(def local-movies-sharp (interop/react-factory LocalMoviesSharp))
(def local-movies-two-tone (interop/react-factory LocalMoviesTwoTone))
(def local-offer (interop/react-factory LocalOffer))
(def local-offer-outlined (interop/react-factory LocalOfferOutlined))
(def local-offer-rounded (interop/react-factory LocalOfferRounded))
(def local-offer-sharp (interop/react-factory LocalOfferSharp))
(def local-offer-two-tone (interop/react-factory LocalOfferTwoTone))
(def local-parking (interop/react-factory LocalParking))
(def local-parking-outlined (interop/react-factory LocalParkingOutlined))
(def local-parking-rounded (interop/react-factory LocalParkingRounded))
(def local-parking-sharp (interop/react-factory LocalParkingSharp))
(def local-parking-two-tone (interop/react-factory LocalParkingTwoTone))
(def local-pharmacy (interop/react-factory LocalPharmacy))
(def local-pharmacy-outlined (interop/react-factory LocalPharmacyOutlined))
(def local-pharmacy-rounded (interop/react-factory LocalPharmacyRounded))
(def local-pharmacy-sharp (interop/react-factory LocalPharmacySharp))
(def local-pharmacy-two-tone (interop/react-factory LocalPharmacyTwoTone))
(def local-phone (interop/react-factory LocalPhone))
(def local-phone-outlined (interop/react-factory LocalPhoneOutlined))
(def local-phone-rounded (interop/react-factory LocalPhoneRounded))
(def local-phone-sharp (interop/react-factory LocalPhoneSharp))
(def local-phone-two-tone (interop/react-factory LocalPhoneTwoTone))
(def local-pizza (interop/react-factory LocalPizza))
(def local-pizza-outlined (interop/react-factory LocalPizzaOutlined))
(def local-pizza-rounded (interop/react-factory LocalPizzaRounded))
(def local-pizza-sharp (interop/react-factory LocalPizzaSharp))
(def local-pizza-two-tone (interop/react-factory LocalPizzaTwoTone))
(def local-play (interop/react-factory LocalPlay))
(def local-play-outlined (interop/react-factory LocalPlayOutlined))
(def local-play-rounded (interop/react-factory LocalPlayRounded))
(def local-play-sharp (interop/react-factory LocalPlaySharp))
(def local-play-two-tone (interop/react-factory LocalPlayTwoTone))
(def local-post-office (interop/react-factory LocalPostOffice))
(def local-post-office-outlined (interop/react-factory LocalPostOfficeOutlined))
(def local-post-office-rounded (interop/react-factory LocalPostOfficeRounded))
(def local-post-office-sharp (interop/react-factory LocalPostOfficeSharp))
(def local-post-office-two-tone (interop/react-factory LocalPostOfficeTwoTone))
(def local-printshop (interop/react-factory LocalPrintshop))
(def local-printshop-outlined (interop/react-factory LocalPrintshopOutlined))
(def local-printshop-rounded (interop/react-factory LocalPrintshopRounded))
(def local-printshop-sharp (interop/react-factory LocalPrintshopSharp))
(def local-printshop-two-tone (interop/react-factory LocalPrintshopTwoTone))
(def local-see (interop/react-factory LocalSee))
(def local-see-outlined (interop/react-factory LocalSeeOutlined))
(def local-see-rounded (interop/react-factory LocalSeeRounded))
(def local-see-sharp (interop/react-factory LocalSeeSharp))
(def local-see-two-tone (interop/react-factory LocalSeeTwoTone))
(def local-shipping (interop/react-factory LocalShipping))
(def local-shipping-outlined (interop/react-factory LocalShippingOutlined))
(def local-shipping-rounded (interop/react-factory LocalShippingRounded))
(def local-shipping-sharp (interop/react-factory LocalShippingSharp))
(def local-shipping-two-tone (interop/react-factory LocalShippingTwoTone))
(def local-taxi (interop/react-factory LocalTaxi))
(def local-taxi-outlined (interop/react-factory LocalTaxiOutlined))
(def local-taxi-rounded (interop/react-factory LocalTaxiRounded))
(def local-taxi-sharp (interop/react-factory LocalTaxiSharp))
(def local-taxi-two-tone (interop/react-factory LocalTaxiTwoTone))
(def location-city (interop/react-factory LocationCity))
(def location-city-outlined (interop/react-factory LocationCityOutlined))
(def location-city-rounded (interop/react-factory LocationCityRounded))
(def location-city-sharp (interop/react-factory LocationCitySharp))
(def location-city-two-tone (interop/react-factory LocationCityTwoTone))
(def location-disabled (interop/react-factory LocationDisabled))
(def location-disabled-outlined (interop/react-factory LocationDisabledOutlined))
(def location-disabled-rounded (interop/react-factory LocationDisabledRounded))
(def location-disabled-sharp (interop/react-factory LocationDisabledSharp))
(def location-disabled-two-tone (interop/react-factory LocationDisabledTwoTone))
(def location-off (interop/react-factory LocationOff))
(def location-off-outlined (interop/react-factory LocationOffOutlined))
(def location-off-rounded (interop/react-factory LocationOffRounded))
(def location-off-sharp (interop/react-factory LocationOffSharp))
(def location-off-two-tone (interop/react-factory LocationOffTwoTone))
(def location-on (interop/react-factory LocationOn))
(def location-on-outlined (interop/react-factory LocationOnOutlined))
(def location-on-rounded (interop/react-factory LocationOnRounded))
(def location-on-sharp (interop/react-factory LocationOnSharp))
(def location-on-two-tone (interop/react-factory LocationOnTwoTone))
(def location-searching (interop/react-factory LocationSearching))
(def location-searching-outlined (interop/react-factory LocationSearchingOutlined))
(def location-searching-rounded (interop/react-factory LocationSearchingRounded))
(def location-searching-sharp (interop/react-factory LocationSearchingSharp))
(def location-searching-two-tone (interop/react-factory LocationSearchingTwoTone))
(def lock (interop/react-factory Lock))
(def lock-open (interop/react-factory LockOpen))
(def lock-open-outlined (interop/react-factory LockOpenOutlined))
(def lock-open-rounded (interop/react-factory LockOpenRounded))
(def lock-open-sharp (interop/react-factory LockOpenSharp))
(def lock-open-two-tone (interop/react-factory LockOpenTwoTone))
(def lock-outlined (interop/react-factory LockOutlined))
(def lock-rounded (interop/react-factory LockRounded))
(def lock-sharp (interop/react-factory LockSharp))
(def lock-two-tone (interop/react-factory LockTwoTone))
(def looks (interop/react-factory Looks))
(def looks3 (interop/react-factory Looks3))
(def looks3-outlined (interop/react-factory Looks3Outlined))
(def looks3-rounded (interop/react-factory Looks3Rounded))
(def looks3-sharp (interop/react-factory Looks3Sharp))
(def looks3-two-tone (interop/react-factory Looks3TwoTone))
(def looks4 (interop/react-factory Looks4))
(def looks4-outlined (interop/react-factory Looks4Outlined))
(def looks4-rounded (interop/react-factory Looks4Rounded))
(def looks4-sharp (interop/react-factory Looks4Sharp))
(def looks4-two-tone (interop/react-factory Looks4TwoTone))
(def looks5 (interop/react-factory Looks5))
(def looks5-outlined (interop/react-factory Looks5Outlined))
(def looks5-rounded (interop/react-factory Looks5Rounded))
(def looks5-sharp (interop/react-factory Looks5Sharp))
(def looks5-two-tone (interop/react-factory Looks5TwoTone))
(def looks6 (interop/react-factory Looks6))
(def looks6-outlined (interop/react-factory Looks6Outlined))
(def looks6-rounded (interop/react-factory Looks6Rounded))
(def looks6-sharp (interop/react-factory Looks6Sharp))
(def looks6-two-tone (interop/react-factory Looks6TwoTone))
(def looks-one (interop/react-factory LooksOne))
(def looks-one-outlined (interop/react-factory LooksOneOutlined))
(def looks-one-rounded (interop/react-factory LooksOneRounded))
(def looks-one-sharp (interop/react-factory LooksOneSharp))
(def looks-one-two-tone (interop/react-factory LooksOneTwoTone))
(def looks-outlined (interop/react-factory LooksOutlined))
(def looks-rounded (interop/react-factory LooksRounded))
(def looks-sharp (interop/react-factory LooksSharp))
(def looks-two (interop/react-factory LooksTwo))
(def looks-two-outlined (interop/react-factory LooksTwoOutlined))
(def looks-two-rounded (interop/react-factory LooksTwoRounded))
(def looks-two-sharp (interop/react-factory LooksTwoSharp))
(def looks-two-tone (interop/react-factory LooksTwoTone))
(def looks-two-two-tone (interop/react-factory LooksTwoTwoTone))
(def loop (interop/react-factory Loop))
(def loop-outlined (interop/react-factory LoopOutlined))
(def loop-rounded (interop/react-factory LoopRounded))
(def loop-sharp (interop/react-factory LoopSharp))
(def loop-two-tone (interop/react-factory LoopTwoTone))
(def loupe (interop/react-factory Loupe))
(def loupe-outlined (interop/react-factory LoupeOutlined))
(def loupe-rounded (interop/react-factory LoupeRounded))
(def loupe-sharp (interop/react-factory LoupeSharp))
(def loupe-two-tone (interop/react-factory LoupeTwoTone))
(def low-priority (interop/react-factory LowPriority))
(def low-priority-outlined (interop/react-factory LowPriorityOutlined))
(def low-priority-rounded (interop/react-factory LowPriorityRounded))
(def low-priority-sharp (interop/react-factory LowPrioritySharp))
(def low-priority-two-tone (interop/react-factory LowPriorityTwoTone))
(def loyalty (interop/react-factory Loyalty))
(def loyalty-outlined (interop/react-factory LoyaltyOutlined))
(def loyalty-rounded (interop/react-factory LoyaltyRounded))
(def loyalty-sharp (interop/react-factory LoyaltySharp))
(def loyalty-two-tone (interop/react-factory LoyaltyTwoTone))
(def mail (interop/react-factory Mail))
(def mail-outline (interop/react-factory MailOutline))
(def mail-outlined (interop/react-factory MailOutlined))
(def mail-outline-outlined (interop/react-factory MailOutlineOutlined))
(def mail-outline-rounded (interop/react-factory MailOutlineRounded))
(def mail-outline-sharp (interop/react-factory MailOutlineSharp))
(def mail-outline-two-tone (interop/react-factory MailOutlineTwoTone))
(def mail-rounded (interop/react-factory MailRounded))
(def mail-sharp (interop/react-factory MailSharp))
(def mail-two-tone (interop/react-factory MailTwoTone))
(def map (interop/react-factory Map))
(def map-outlined (interop/react-factory MapOutlined))
(def map-rounded (interop/react-factory MapRounded))
(def map-sharp (interop/react-factory MapSharp))
(def map-two-tone (interop/react-factory MapTwoTone))
(def markunread (interop/react-factory Markunread))
(def markunread-mailbox (interop/react-factory MarkunreadMailbox))
(def markunread-mailbox-outlined (interop/react-factory MarkunreadMailboxOutlined))
(def markunread-mailbox-rounded (interop/react-factory MarkunreadMailboxRounded))
(def markunread-mailbox-sharp (interop/react-factory MarkunreadMailboxSharp))
(def markunread-mailbox-two-tone (interop/react-factory MarkunreadMailboxTwoTone))
(def markunread-outlined (interop/react-factory MarkunreadOutlined))
(def markunread-rounded (interop/react-factory MarkunreadRounded))
(def markunread-sharp (interop/react-factory MarkunreadSharp))
(def markunread-two-tone (interop/react-factory MarkunreadTwoTone))
(def maximize (interop/react-factory Maximize))
(def maximize-outlined (interop/react-factory MaximizeOutlined))
(def maximize-rounded (interop/react-factory MaximizeRounded))
(def maximize-sharp (interop/react-factory MaximizeSharp))
(def maximize-two-tone (interop/react-factory MaximizeTwoTone))
(def meeting-room (interop/react-factory MeetingRoom))
(def meeting-room-outlined (interop/react-factory MeetingRoomOutlined))
(def meeting-room-rounded (interop/react-factory MeetingRoomRounded))
(def meeting-room-sharp (interop/react-factory MeetingRoomSharp))
(def meeting-room-two-tone (interop/react-factory MeetingRoomTwoTone))
(def memory (interop/react-factory Memory))
(def memory-outlined (interop/react-factory MemoryOutlined))
(def memory-rounded (interop/react-factory MemoryRounded))
(def memory-sharp (interop/react-factory MemorySharp))
(def memory-two-tone (interop/react-factory MemoryTwoTone))
(def menu (interop/react-factory Menu))
(def menu-book (interop/react-factory MenuBook))
(def menu-book-outlined (interop/react-factory MenuBookOutlined))
(def menu-book-rounded (interop/react-factory MenuBookRounded))
(def menu-book-sharp (interop/react-factory MenuBookSharp))
(def menu-book-two-tone (interop/react-factory MenuBookTwoTone))
(def menu-open (interop/react-factory MenuOpen))
(def menu-open-outlined (interop/react-factory MenuOpenOutlined))
(def menu-open-rounded (interop/react-factory MenuOpenRounded))
(def menu-open-sharp (interop/react-factory MenuOpenSharp))
(def menu-open-two-tone (interop/react-factory MenuOpenTwoTone))
(def menu-outlined (interop/react-factory MenuOutlined))
(def menu-rounded (interop/react-factory MenuRounded))
(def menu-sharp (interop/react-factory MenuSharp))
(def menu-two-tone (interop/react-factory MenuTwoTone))
(def merge-type (interop/react-factory MergeType))
(def merge-type-outlined (interop/react-factory MergeTypeOutlined))
(def merge-type-rounded (interop/react-factory MergeTypeRounded))
(def merge-type-sharp (interop/react-factory MergeTypeSharp))
(def merge-type-two-tone (interop/react-factory MergeTypeTwoTone))
(def message (interop/react-factory Message))
(def message-outlined (interop/react-factory MessageOutlined))
(def message-rounded (interop/react-factory MessageRounded))
(def message-sharp (interop/react-factory MessageSharp))
(def message-two-tone (interop/react-factory MessageTwoTone))
(def mic (interop/react-factory Mic))
(def mic-none (interop/react-factory MicNone))
(def mic-none-outlined (interop/react-factory MicNoneOutlined))
(def mic-none-rounded (interop/react-factory MicNoneRounded))
(def mic-none-sharp (interop/react-factory MicNoneSharp))
(def mic-none-two-tone (interop/react-factory MicNoneTwoTone))
(def mic-off (interop/react-factory MicOff))
(def mic-off-outlined (interop/react-factory MicOffOutlined))
(def mic-off-rounded (interop/react-factory MicOffRounded))
(def mic-off-sharp (interop/react-factory MicOffSharp))
(def mic-off-two-tone (interop/react-factory MicOffTwoTone))
(def mic-outlined (interop/react-factory MicOutlined))
(def mic-rounded (interop/react-factory MicRounded))
(def mic-sharp (interop/react-factory MicSharp))
(def mic-two-tone (interop/react-factory MicTwoTone))
(def minimize (interop/react-factory Minimize))
(def minimize-outlined (interop/react-factory MinimizeOutlined))
(def minimize-rounded (interop/react-factory MinimizeRounded))
(def minimize-sharp (interop/react-factory MinimizeSharp))
(def minimize-two-tone (interop/react-factory MinimizeTwoTone))
(def missed-video-call (interop/react-factory MissedVideoCall))
(def missed-video-call-outlined (interop/react-factory MissedVideoCallOutlined))
(def missed-video-call-rounded (interop/react-factory MissedVideoCallRounded))
(def missed-video-call-sharp (interop/react-factory MissedVideoCallSharp))
(def missed-video-call-two-tone (interop/react-factory MissedVideoCallTwoTone))
(def mms (interop/react-factory Mms))
(def mms-outlined (interop/react-factory MmsOutlined))
(def mms-rounded (interop/react-factory MmsRounded))
(def mms-sharp (interop/react-factory MmsSharp))
(def mms-two-tone (interop/react-factory MmsTwoTone))
(def mobile-friendly (interop/react-factory MobileFriendly))
(def mobile-friendly-outlined (interop/react-factory MobileFriendlyOutlined))
(def mobile-friendly-rounded (interop/react-factory MobileFriendlyRounded))
(def mobile-friendly-sharp (interop/react-factory MobileFriendlySharp))
(def mobile-friendly-two-tone (interop/react-factory MobileFriendlyTwoTone))
(def mobile-off (interop/react-factory MobileOff))
(def mobile-off-outlined (interop/react-factory MobileOffOutlined))
(def mobile-off-rounded (interop/react-factory MobileOffRounded))
(def mobile-off-sharp (interop/react-factory MobileOffSharp))
(def mobile-off-two-tone (interop/react-factory MobileOffTwoTone))
(def mobile-screen-share (interop/react-factory MobileScreenShare))
(def mobile-screen-share-outlined (interop/react-factory MobileScreenShareOutlined))
(def mobile-screen-share-rounded (interop/react-factory MobileScreenShareRounded))
(def mobile-screen-share-sharp (interop/react-factory MobileScreenShareSharp))
(def mobile-screen-share-two-tone (interop/react-factory MobileScreenShareTwoTone))
(def mode-comment (interop/react-factory ModeComment))
(def mode-comment-outlined (interop/react-factory ModeCommentOutlined))
(def mode-comment-rounded (interop/react-factory ModeCommentRounded))
(def mode-comment-sharp (interop/react-factory ModeCommentSharp))
(def mode-comment-two-tone (interop/react-factory ModeCommentTwoTone))
(def monetization-on (interop/react-factory MonetizationOn))
(def monetization-on-outlined (interop/react-factory MonetizationOnOutlined))
(def monetization-on-rounded (interop/react-factory MonetizationOnRounded))
(def monetization-on-sharp (interop/react-factory MonetizationOnSharp))
(def monetization-on-two-tone (interop/react-factory MonetizationOnTwoTone))
(def money (interop/react-factory Money))
(def money-off (interop/react-factory MoneyOff))
(def money-off-outlined (interop/react-factory MoneyOffOutlined))
(def money-off-rounded (interop/react-factory MoneyOffRounded))
(def money-off-sharp (interop/react-factory MoneyOffSharp))
(def money-off-two-tone (interop/react-factory MoneyOffTwoTone))
(def money-outlined (interop/react-factory MoneyOutlined))
(def money-rounded (interop/react-factory MoneyRounded))
(def money-sharp (interop/react-factory MoneySharp))
(def money-two-tone (interop/react-factory MoneyTwoTone))
(def monochrome-photos (interop/react-factory MonochromePhotos))
(def monochrome-photos-outlined (interop/react-factory MonochromePhotosOutlined))
(def monochrome-photos-rounded (interop/react-factory MonochromePhotosRounded))
(def monochrome-photos-sharp (interop/react-factory MonochromePhotosSharp))
(def monochrome-photos-two-tone (interop/react-factory MonochromePhotosTwoTone))
(def mood (interop/react-factory Mood))
(def mood-bad (interop/react-factory MoodBad))
(def mood-bad-outlined (interop/react-factory MoodBadOutlined))
(def mood-bad-rounded (interop/react-factory MoodBadRounded))
(def mood-bad-sharp (interop/react-factory MoodBadSharp))
(def mood-bad-two-tone (interop/react-factory MoodBadTwoTone))
(def mood-outlined (interop/react-factory MoodOutlined))
(def mood-rounded (interop/react-factory MoodRounded))
(def mood-sharp (interop/react-factory MoodSharp))
(def mood-two-tone (interop/react-factory MoodTwoTone))
(def more (interop/react-factory More))
(def more-horiz (interop/react-factory MoreHoriz))
(def more-horiz-outlined (interop/react-factory MoreHorizOutlined))
(def more-horiz-rounded (interop/react-factory MoreHorizRounded))
(def more-horiz-sharp (interop/react-factory MoreHorizSharp))
(def more-horiz-two-tone (interop/react-factory MoreHorizTwoTone))
(def more-outlined (interop/react-factory MoreOutlined))
(def more-rounded (interop/react-factory MoreRounded))
(def more-sharp (interop/react-factory MoreSharp))
(def more-two-tone (interop/react-factory MoreTwoTone))
(def more-vert (interop/react-factory MoreVert))
(def more-vert-outlined (interop/react-factory MoreVertOutlined))
(def more-vert-rounded (interop/react-factory MoreVertRounded))
(def more-vert-sharp (interop/react-factory MoreVertSharp))
(def more-vert-two-tone (interop/react-factory MoreVertTwoTone))
(def motorcycle (interop/react-factory Motorcycle))
(def motorcycle-outlined (interop/react-factory MotorcycleOutlined))
(def motorcycle-rounded (interop/react-factory MotorcycleRounded))
(def motorcycle-sharp (interop/react-factory MotorcycleSharp))
(def motorcycle-two-tone (interop/react-factory MotorcycleTwoTone))
(def mouse (interop/react-factory Mouse))
(def mouse-outlined (interop/react-factory MouseOutlined))
(def mouse-rounded (interop/react-factory MouseRounded))
(def mouse-sharp (interop/react-factory MouseSharp))
(def mouse-two-tone (interop/react-factory MouseTwoTone))
(def move-to-inbox (interop/react-factory MoveToInbox))
(def move-to-inbox-outlined (interop/react-factory MoveToInboxOutlined))
(def move-to-inbox-rounded (interop/react-factory MoveToInboxRounded))
(def move-to-inbox-sharp (interop/react-factory MoveToInboxSharp))
(def move-to-inbox-two-tone (interop/react-factory MoveToInboxTwoTone))
(def movie (interop/react-factory Movie))
(def movie-creation (interop/react-factory MovieCreation))
(def movie-creation-outlined (interop/react-factory MovieCreationOutlined))
(def movie-creation-rounded (interop/react-factory MovieCreationRounded))
(def movie-creation-sharp (interop/react-factory MovieCreationSharp))
(def movie-creation-two-tone (interop/react-factory MovieCreationTwoTone))
(def movie-filter (interop/react-factory MovieFilter))
(def movie-filter-outlined (interop/react-factory MovieFilterOutlined))
(def movie-filter-rounded (interop/react-factory MovieFilterRounded))
(def movie-filter-sharp (interop/react-factory MovieFilterSharp))
(def movie-filter-two-tone (interop/react-factory MovieFilterTwoTone))
(def movie-outlined (interop/react-factory MovieOutlined))
(def movie-rounded (interop/react-factory MovieRounded))
(def movie-sharp (interop/react-factory MovieSharp))
(def movie-two-tone (interop/react-factory MovieTwoTone))
(def multiline-chart (interop/react-factory MultilineChart))
(def multiline-chart-outlined (interop/react-factory MultilineChartOutlined))
(def multiline-chart-rounded (interop/react-factory MultilineChartRounded))
(def multiline-chart-sharp (interop/react-factory MultilineChartSharp))
(def multiline-chart-two-tone (interop/react-factory MultilineChartTwoTone))
(def museum (interop/react-factory Museum))
(def museum-outlined (interop/react-factory MuseumOutlined))
(def museum-rounded (interop/react-factory MuseumRounded))
(def museum-sharp (interop/react-factory MuseumSharp))
(def museum-two-tone (interop/react-factory MuseumTwoTone))
(def music-note (interop/react-factory MusicNote))
(def music-note-outlined (interop/react-factory MusicNoteOutlined))
(def music-note-rounded (interop/react-factory MusicNoteRounded))
(def music-note-sharp (interop/react-factory MusicNoteSharp))
(def music-note-two-tone (interop/react-factory MusicNoteTwoTone))
(def music-off (interop/react-factory MusicOff))
(def music-off-outlined (interop/react-factory MusicOffOutlined))
(def music-off-rounded (interop/react-factory MusicOffRounded))
(def music-off-sharp (interop/react-factory MusicOffSharp))
(def music-off-two-tone (interop/react-factory MusicOffTwoTone))
(def music-video (interop/react-factory MusicVideo))
(def music-video-outlined (interop/react-factory MusicVideoOutlined))
(def music-video-rounded (interop/react-factory MusicVideoRounded))
(def music-video-sharp (interop/react-factory MusicVideoSharp))
(def music-video-two-tone (interop/react-factory MusicVideoTwoTone))
(def my-location (interop/react-factory MyLocation))
(def my-location-outlined (interop/react-factory MyLocationOutlined))
(def my-location-rounded (interop/react-factory MyLocationRounded))
(def my-location-sharp (interop/react-factory MyLocationSharp))
(def my-location-two-tone (interop/react-factory MyLocationTwoTone))
(def nature (interop/react-factory Nature))
(def nature-outlined (interop/react-factory NatureOutlined))
(def nature-people (interop/react-factory NaturePeople))
(def nature-people-outlined (interop/react-factory NaturePeopleOutlined))
(def nature-people-rounded (interop/react-factory NaturePeopleRounded))
(def nature-people-sharp (interop/react-factory NaturePeopleSharp))
(def nature-people-two-tone (interop/react-factory NaturePeopleTwoTone))
(def nature-rounded (interop/react-factory NatureRounded))
(def nature-sharp (interop/react-factory NatureSharp))
(def nature-two-tone (interop/react-factory NatureTwoTone))
(def navigate-before (interop/react-factory NavigateBefore))
(def navigate-before-outlined (interop/react-factory NavigateBeforeOutlined))
(def navigate-before-rounded (interop/react-factory NavigateBeforeRounded))
(def navigate-before-sharp (interop/react-factory NavigateBeforeSharp))
(def navigate-before-two-tone (interop/react-factory NavigateBeforeTwoTone))
(def navigate-next (interop/react-factory NavigateNext))
(def navigate-next-outlined (interop/react-factory NavigateNextOutlined))
(def navigate-next-rounded (interop/react-factory NavigateNextRounded))
(def navigate-next-sharp (interop/react-factory NavigateNextSharp))
(def navigate-next-two-tone (interop/react-factory NavigateNextTwoTone))
(def navigation (interop/react-factory Navigation))
(def navigation-outlined (interop/react-factory NavigationOutlined))
(def navigation-rounded (interop/react-factory NavigationRounded))
(def navigation-sharp (interop/react-factory NavigationSharp))
(def navigation-two-tone (interop/react-factory NavigationTwoTone))
(def near-me (interop/react-factory NearMe))
(def near-me-outlined (interop/react-factory NearMeOutlined))
(def near-me-rounded (interop/react-factory NearMeRounded))
(def near-me-sharp (interop/react-factory NearMeSharp))
(def near-me-two-tone (interop/react-factory NearMeTwoTone))
(def network-cell (interop/react-factory NetworkCell))
(def network-cell-outlined (interop/react-factory NetworkCellOutlined))
(def network-cell-rounded (interop/react-factory NetworkCellRounded))
(def network-cell-sharp (interop/react-factory NetworkCellSharp))
(def network-cell-two-tone (interop/react-factory NetworkCellTwoTone))
(def network-check (interop/react-factory NetworkCheck))
(def network-check-outlined (interop/react-factory NetworkCheckOutlined))
(def network-check-rounded (interop/react-factory NetworkCheckRounded))
(def network-check-sharp (interop/react-factory NetworkCheckSharp))
(def network-check-two-tone (interop/react-factory NetworkCheckTwoTone))
(def network-locked (interop/react-factory NetworkLocked))
(def network-locked-outlined (interop/react-factory NetworkLockedOutlined))
(def network-locked-rounded (interop/react-factory NetworkLockedRounded))
(def network-locked-sharp (interop/react-factory NetworkLockedSharp))
(def network-locked-two-tone (interop/react-factory NetworkLockedTwoTone))
(def network-wifi (interop/react-factory NetworkWifi))
(def network-wifi-outlined (interop/react-factory NetworkWifiOutlined))
(def network-wifi-rounded (interop/react-factory NetworkWifiRounded))
(def network-wifi-sharp (interop/react-factory NetworkWifiSharp))
(def network-wifi-two-tone (interop/react-factory NetworkWifiTwoTone))
(def new-releases (interop/react-factory NewReleases))
(def new-releases-outlined (interop/react-factory NewReleasesOutlined))
(def new-releases-rounded (interop/react-factory NewReleasesRounded))
(def new-releases-sharp (interop/react-factory NewReleasesSharp))
(def new-releases-two-tone (interop/react-factory NewReleasesTwoTone))
(def next-week (interop/react-factory NextWeek))
(def next-week-outlined (interop/react-factory NextWeekOutlined))
(def next-week-rounded (interop/react-factory NextWeekRounded))
(def next-week-sharp (interop/react-factory NextWeekSharp))
(def next-week-two-tone (interop/react-factory NextWeekTwoTone))
(def nfc (interop/react-factory Nfc))
(def nfc-outlined (interop/react-factory NfcOutlined))
(def nfc-rounded (interop/react-factory NfcRounded))
(def nfc-sharp (interop/react-factory NfcSharp))
(def nfc-two-tone (interop/react-factory NfcTwoTone))
(def nights-stay (interop/react-factory NightsStay))
(def nights-stay-outlined (interop/react-factory NightsStayOutlined))
(def nights-stay-rounded (interop/react-factory NightsStayRounded))
(def nights-stay-sharp (interop/react-factory NightsStaySharp))
(def nights-stay-two-tone (interop/react-factory NightsStayTwoTone))
(def no-encryption (interop/react-factory NoEncryption))
(def no-encryption-outlined (interop/react-factory NoEncryptionOutlined))
(def no-encryption-rounded (interop/react-factory NoEncryptionRounded))
(def no-encryption-sharp (interop/react-factory NoEncryptionSharp))
(def no-encryption-two-tone (interop/react-factory NoEncryptionTwoTone))
(def no-meeting-room (interop/react-factory NoMeetingRoom))
(def no-meeting-room-outlined (interop/react-factory NoMeetingRoomOutlined))
(def no-meeting-room-rounded (interop/react-factory NoMeetingRoomRounded))
(def no-meeting-room-sharp (interop/react-factory NoMeetingRoomSharp))
(def no-meeting-room-two-tone (interop/react-factory NoMeetingRoomTwoTone))
(def no-sim (interop/react-factory NoSim))
(def no-sim-outlined (interop/react-factory NoSimOutlined))
(def no-sim-rounded (interop/react-factory NoSimRounded))
(def no-sim-sharp (interop/react-factory NoSimSharp))
(def no-sim-two-tone (interop/react-factory NoSimTwoTone))
(def note (interop/react-factory Note))
(def note-add (interop/react-factory NoteAdd))
(def note-add-outlined (interop/react-factory NoteAddOutlined))
(def note-add-rounded (interop/react-factory NoteAddRounded))
(def note-add-sharp (interop/react-factory NoteAddSharp))
(def note-add-two-tone (interop/react-factory NoteAddTwoTone))
(def note-outlined (interop/react-factory NoteOutlined))
(def note-rounded (interop/react-factory NoteRounded))
(def notes (interop/react-factory Notes))
(def note-sharp (interop/react-factory NoteSharp))
(def notes-outlined (interop/react-factory NotesOutlined))
(def notes-rounded (interop/react-factory NotesRounded))
(def notes-sharp (interop/react-factory NotesSharp))
(def notes-two-tone (interop/react-factory NotesTwoTone))
(def note-two-tone (interop/react-factory NoteTwoTone))
(def notification-important (interop/react-factory NotificationImportant))
(def notification-important-outlined (interop/react-factory NotificationImportantOutlined))
(def notification-important-rounded (interop/react-factory NotificationImportantRounded))
(def notification-important-sharp (interop/react-factory NotificationImportantSharp))
(def notification-important-two-tone (interop/react-factory NotificationImportantTwoTone))
(def notifications (interop/react-factory Notifications))
(def notifications-active (interop/react-factory NotificationsActive))
(def notifications-active-outlined (interop/react-factory NotificationsActiveOutlined))
(def notifications-active-rounded (interop/react-factory NotificationsActiveRounded))
(def notifications-active-sharp (interop/react-factory NotificationsActiveSharp))
(def notifications-active-two-tone (interop/react-factory NotificationsActiveTwoTone))
(def notifications-none (interop/react-factory NotificationsNone))
(def notifications-none-outlined (interop/react-factory NotificationsNoneOutlined))
(def notifications-none-rounded (interop/react-factory NotificationsNoneRounded))
(def notifications-none-sharp (interop/react-factory NotificationsNoneSharp))
(def notifications-none-two-tone (interop/react-factory NotificationsNoneTwoTone))
(def notifications-off (interop/react-factory NotificationsOff))
(def notifications-off-outlined (interop/react-factory NotificationsOffOutlined))
(def notifications-off-rounded (interop/react-factory NotificationsOffRounded))
(def notifications-off-sharp (interop/react-factory NotificationsOffSharp))
(def notifications-off-two-tone (interop/react-factory NotificationsOffTwoTone))
(def notifications-outlined (interop/react-factory NotificationsOutlined))
(def notifications-paused (interop/react-factory NotificationsPaused))
(def notifications-paused-outlined (interop/react-factory NotificationsPausedOutlined))
(def notifications-paused-rounded (interop/react-factory NotificationsPausedRounded))
(def notifications-paused-sharp (interop/react-factory NotificationsPausedSharp))
(def notifications-paused-two-tone (interop/react-factory NotificationsPausedTwoTone))
(def notifications-rounded (interop/react-factory NotificationsRounded))
(def notifications-sharp (interop/react-factory NotificationsSharp))
(def notifications-two-tone (interop/react-factory NotificationsTwoTone))
(def not-interested (interop/react-factory NotInterested))
(def not-interested-outlined (interop/react-factory NotInterestedOutlined))
(def not-interested-rounded (interop/react-factory NotInterestedRounded))
(def not-interested-sharp (interop/react-factory NotInterestedSharp))
(def not-interested-two-tone (interop/react-factory NotInterestedTwoTone))
(def not-listed-location (interop/react-factory NotListedLocation))
(def not-listed-location-outlined (interop/react-factory NotListedLocationOutlined))
(def not-listed-location-rounded (interop/react-factory NotListedLocationRounded))
(def not-listed-location-sharp (interop/react-factory NotListedLocationSharp))
(def not-listed-location-two-tone (interop/react-factory NotListedLocationTwoTone))
(def offline-bolt (interop/react-factory OfflineBolt))
(def offline-bolt-outlined (interop/react-factory OfflineBoltOutlined))
(def offline-bolt-rounded (interop/react-factory OfflineBoltRounded))
(def offline-bolt-sharp (interop/react-factory OfflineBoltSharp))
(def offline-bolt-two-tone (interop/react-factory OfflineBoltTwoTone))
(def offline-pin (interop/react-factory OfflinePin))
(def offline-pin-outlined (interop/react-factory OfflinePinOutlined))
(def offline-pin-rounded (interop/react-factory OfflinePinRounded))
(def offline-pin-sharp (interop/react-factory OfflinePinSharp))
(def offline-pin-two-tone (interop/react-factory OfflinePinTwoTone))
(def ondemand-video (interop/react-factory OndemandVideo))
(def ondemand-video-outlined (interop/react-factory OndemandVideoOutlined))
(def ondemand-video-rounded (interop/react-factory OndemandVideoRounded))
(def ondemand-video-sharp (interop/react-factory OndemandVideoSharp))
(def ondemand-video-two-tone (interop/react-factory OndemandVideoTwoTone))
(def opacity (interop/react-factory Opacity))
(def opacity-outlined (interop/react-factory OpacityOutlined))
(def opacity-rounded (interop/react-factory OpacityRounded))
(def opacity-sharp (interop/react-factory OpacitySharp))
(def opacity-two-tone (interop/react-factory OpacityTwoTone))
(def open-in-browser (interop/react-factory OpenInBrowser))
(def open-in-browser-outlined (interop/react-factory OpenInBrowserOutlined))
(def open-in-browser-rounded (interop/react-factory OpenInBrowserRounded))
(def open-in-browser-sharp (interop/react-factory OpenInBrowserSharp))
(def open-in-browser-two-tone (interop/react-factory OpenInBrowserTwoTone))
(def open-in-new (interop/react-factory OpenInNew))
(def open-in-new-outlined (interop/react-factory OpenInNewOutlined))
(def open-in-new-rounded (interop/react-factory OpenInNewRounded))
(def open-in-new-sharp (interop/react-factory OpenInNewSharp))
(def open-in-new-two-tone (interop/react-factory OpenInNewTwoTone))
(def open-with (interop/react-factory OpenWith))
(def open-with-outlined (interop/react-factory OpenWithOutlined))
(def open-with-rounded (interop/react-factory OpenWithRounded))
(def open-with-sharp (interop/react-factory OpenWithSharp))
(def open-with-two-tone (interop/react-factory OpenWithTwoTone))
(def outdoor-grill (interop/react-factory OutdoorGrill))
(def outdoor-grill-outlined (interop/react-factory OutdoorGrillOutlined))
(def outdoor-grill-rounded (interop/react-factory OutdoorGrillRounded))
(def outdoor-grill-sharp (interop/react-factory OutdoorGrillSharp))
(def outdoor-grill-two-tone (interop/react-factory OutdoorGrillTwoTone))
(def outlined-flag (interop/react-factory OutlinedFlag))
(def outlined-flag-outlined (interop/react-factory OutlinedFlagOutlined))
(def outlined-flag-rounded (interop/react-factory OutlinedFlagRounded))
(def outlined-flag-sharp (interop/react-factory OutlinedFlagSharp))
(def outlined-flag-two-tone (interop/react-factory OutlinedFlagTwoTone))
(def pages (interop/react-factory Pages))
(def pages-outlined (interop/react-factory PagesOutlined))
(def pages-rounded (interop/react-factory PagesRounded))
(def pages-sharp (interop/react-factory PagesSharp))
(def pages-two-tone (interop/react-factory PagesTwoTone))
(def pageview (interop/react-factory Pageview))
(def pageview-outlined (interop/react-factory PageviewOutlined))
(def pageview-rounded (interop/react-factory PageviewRounded))
(def pageview-sharp (interop/react-factory PageviewSharp))
(def pageview-two-tone (interop/react-factory PageviewTwoTone))
(def palette (interop/react-factory Palette))
(def palette-outlined (interop/react-factory PaletteOutlined))
(def palette-rounded (interop/react-factory PaletteRounded))
(def palette-sharp (interop/react-factory PaletteSharp))
(def palette-two-tone (interop/react-factory PaletteTwoTone))
(def panorama (interop/react-factory Panorama))
(def panorama-fish-eye (interop/react-factory PanoramaFishEye))
(def panorama-fish-eye-outlined (interop/react-factory PanoramaFishEyeOutlined))
(def panorama-fish-eye-rounded (interop/react-factory PanoramaFishEyeRounded))
(def panorama-fish-eye-sharp (interop/react-factory PanoramaFishEyeSharp))
(def panorama-fish-eye-two-tone (interop/react-factory PanoramaFishEyeTwoTone))
(def panorama-horizontal (interop/react-factory PanoramaHorizontal))
(def panorama-horizontal-outlined (interop/react-factory PanoramaHorizontalOutlined))
(def panorama-horizontal-rounded (interop/react-factory PanoramaHorizontalRounded))
(def panorama-horizontal-sharp (interop/react-factory PanoramaHorizontalSharp))
(def panorama-horizontal-two-tone (interop/react-factory PanoramaHorizontalTwoTone))
(def panorama-outlined (interop/react-factory PanoramaOutlined))
(def panorama-rounded (interop/react-factory PanoramaRounded))
(def panorama-sharp (interop/react-factory PanoramaSharp))
(def panorama-two-tone (interop/react-factory PanoramaTwoTone))
(def panorama-vertical (interop/react-factory PanoramaVertical))
(def panorama-vertical-outlined (interop/react-factory PanoramaVerticalOutlined))
(def panorama-vertical-rounded (interop/react-factory PanoramaVerticalRounded))
(def panorama-vertical-sharp (interop/react-factory PanoramaVerticalSharp))
(def panorama-vertical-two-tone (interop/react-factory PanoramaVerticalTwoTone))
(def panorama-wide-angle (interop/react-factory PanoramaWideAngle))
(def panorama-wide-angle-outlined (interop/react-factory PanoramaWideAngleOutlined))
(def panorama-wide-angle-rounded (interop/react-factory PanoramaWideAngleRounded))
(def panorama-wide-angle-sharp (interop/react-factory PanoramaWideAngleSharp))
(def panorama-wide-angle-two-tone (interop/react-factory PanoramaWideAngleTwoTone))
(def pan-tool (interop/react-factory PanTool))
(def pan-tool-outlined (interop/react-factory PanToolOutlined))
(def pan-tool-rounded (interop/react-factory PanToolRounded))
(def pan-tool-sharp (interop/react-factory PanToolSharp))
(def pan-tool-two-tone (interop/react-factory PanToolTwoTone))
(def party-mode (interop/react-factory PartyMode))
(def party-mode-outlined (interop/react-factory PartyModeOutlined))
(def party-mode-rounded (interop/react-factory PartyModeRounded))
(def party-mode-sharp (interop/react-factory PartyModeSharp))
(def party-mode-two-tone (interop/react-factory PartyModeTwoTone))
(def pause (interop/react-factory Pause))
(def pause-circle-filled (interop/react-factory PauseCircleFilled))
(def pause-circle-filled-outlined (interop/react-factory PauseCircleFilledOutlined))
(def pause-circle-filled-rounded (interop/react-factory PauseCircleFilledRounded))
(def pause-circle-filled-sharp (interop/react-factory PauseCircleFilledSharp))
(def pause-circle-filled-two-tone (interop/react-factory PauseCircleFilledTwoTone))
(def pause-circle-outline (interop/react-factory PauseCircleOutline))
(def pause-circle-outline-outlined (interop/react-factory PauseCircleOutlineOutlined))
(def pause-circle-outline-rounded (interop/react-factory PauseCircleOutlineRounded))
(def pause-circle-outline-sharp (interop/react-factory PauseCircleOutlineSharp))
(def pause-circle-outline-two-tone (interop/react-factory PauseCircleOutlineTwoTone))
(def pause-outlined (interop/react-factory PauseOutlined))
(def pause-presentation (interop/react-factory PausePresentation))
(def pause-presentation-outlined (interop/react-factory PausePresentationOutlined))
(def pause-presentation-rounded (interop/react-factory PausePresentationRounded))
(def pause-presentation-sharp (interop/react-factory PausePresentationSharp))
(def pause-presentation-two-tone (interop/react-factory PausePresentationTwoTone))
(def pause-rounded (interop/react-factory PauseRounded))
(def pause-sharp (interop/react-factory PauseSharp))
(def pause-two-tone (interop/react-factory PauseTwoTone))
(def payment (interop/react-factory Payment))
(def payment-outlined (interop/react-factory PaymentOutlined))
(def payment-rounded (interop/react-factory PaymentRounded))
(def payment-sharp (interop/react-factory PaymentSharp))
(def payment-two-tone (interop/react-factory PaymentTwoTone))
(def people (interop/react-factory People))
(def people-alt (interop/react-factory PeopleAlt))
(def people-alt-outlined (interop/react-factory PeopleAltOutlined))
(def people-alt-rounded (interop/react-factory PeopleAltRounded))
(def people-alt-sharp (interop/react-factory PeopleAltSharp))
(def people-alt-two-tone (interop/react-factory PeopleAltTwoTone))
(def people-outline (interop/react-factory PeopleOutline))
(def people-outlined (interop/react-factory PeopleOutlined))
(def people-outline-outlined (interop/react-factory PeopleOutlineOutlined))
(def people-outline-rounded (interop/react-factory PeopleOutlineRounded))
(def people-outline-sharp (interop/react-factory PeopleOutlineSharp))
(def people-outline-two-tone (interop/react-factory PeopleOutlineTwoTone))
(def people-rounded (interop/react-factory PeopleRounded))
(def people-sharp (interop/react-factory PeopleSharp))
(def people-two-tone (interop/react-factory PeopleTwoTone))
(def perm-camera-mic (interop/react-factory PermCameraMic))
(def perm-camera-mic-outlined (interop/react-factory PermCameraMicOutlined))
(def perm-camera-mic-rounded (interop/react-factory PermCameraMicRounded))
(def perm-camera-mic-sharp (interop/react-factory PermCameraMicSharp))
(def perm-camera-mic-two-tone (interop/react-factory PermCameraMicTwoTone))
(def perm-contact-calendar (interop/react-factory PermContactCalendar))
(def perm-contact-calendar-outlined (interop/react-factory PermContactCalendarOutlined))
(def perm-contact-calendar-rounded (interop/react-factory PermContactCalendarRounded))
(def perm-contact-calendar-sharp (interop/react-factory PermContactCalendarSharp))
(def perm-contact-calendar-two-tone (interop/react-factory PermContactCalendarTwoTone))
(def perm-data-setting (interop/react-factory PermDataSetting))
(def perm-data-setting-outlined (interop/react-factory PermDataSettingOutlined))
(def perm-data-setting-rounded (interop/react-factory PermDataSettingRounded))
(def perm-data-setting-sharp (interop/react-factory PermDataSettingSharp))
(def perm-data-setting-two-tone (interop/react-factory PermDataSettingTwoTone))
(def perm-device-information (interop/react-factory PermDeviceInformation))
(def perm-device-information-outlined (interop/react-factory PermDeviceInformationOutlined))
(def perm-device-information-rounded (interop/react-factory PermDeviceInformationRounded))
(def perm-device-information-sharp (interop/react-factory PermDeviceInformationSharp))
(def perm-device-information-two-tone (interop/react-factory PermDeviceInformationTwoTone))
(def perm-identity (interop/react-factory PermIdentity))
(def perm-identity-outlined (interop/react-factory PermIdentityOutlined))
(def perm-identity-rounded (interop/react-factory PermIdentityRounded))
(def perm-identity-sharp (interop/react-factory PermIdentitySharp))
(def perm-identity-two-tone (interop/react-factory PermIdentityTwoTone))
(def perm-media (interop/react-factory PermMedia))
(def perm-media-outlined (interop/react-factory PermMediaOutlined))
(def perm-media-rounded (interop/react-factory PermMediaRounded))
(def perm-media-sharp (interop/react-factory PermMediaSharp))
(def perm-media-two-tone (interop/react-factory PermMediaTwoTone))
(def perm-phone-msg (interop/react-factory PermPhoneMsg))
(def perm-phone-msg-outlined (interop/react-factory PermPhoneMsgOutlined))
(def perm-phone-msg-rounded (interop/react-factory PermPhoneMsgRounded))
(def perm-phone-msg-sharp (interop/react-factory PermPhoneMsgSharp))
(def perm-phone-msg-two-tone (interop/react-factory PermPhoneMsgTwoTone))
(def perm-scan-wifi (interop/react-factory PermScanWifi))
(def perm-scan-wifi-outlined (interop/react-factory PermScanWifiOutlined))
(def perm-scan-wifi-rounded (interop/react-factory PermScanWifiRounded))
(def perm-scan-wifi-sharp (interop/react-factory PermScanWifiSharp))
(def perm-scan-wifi-two-tone (interop/react-factory PermScanWifiTwoTone))
(def person (interop/react-factory Person))
(def person-add (interop/react-factory PersonAdd))
(def person-add-disabled (interop/react-factory PersonAddDisabled))
(def person-add-disabled-outlined (interop/react-factory PersonAddDisabledOutlined))
(def person-add-disabled-rounded (interop/react-factory PersonAddDisabledRounded))
(def person-add-disabled-sharp (interop/react-factory PersonAddDisabledSharp))
(def person-add-disabled-two-tone (interop/react-factory PersonAddDisabledTwoTone))
(def person-add-outlined (interop/react-factory PersonAddOutlined))
(def person-add-rounded (interop/react-factory PersonAddRounded))
(def person-add-sharp (interop/react-factory PersonAddSharp))
(def person-add-two-tone (interop/react-factory PersonAddTwoTone))
(def personal-video (interop/react-factory PersonalVideo))
(def personal-video-outlined (interop/react-factory PersonalVideoOutlined))
(def personal-video-rounded (interop/react-factory PersonalVideoRounded))
(def personal-video-sharp (interop/react-factory PersonalVideoSharp))
(def personal-video-two-tone (interop/react-factory PersonalVideoTwoTone))
(def person-outline (interop/react-factory PersonOutline))
(def person-outlined (interop/react-factory PersonOutlined))
(def person-outline-outlined (interop/react-factory PersonOutlineOutlined))
(def person-outline-rounded (interop/react-factory PersonOutlineRounded))
(def person-outline-sharp (interop/react-factory PersonOutlineSharp))
(def person-outline-two-tone (interop/react-factory PersonOutlineTwoTone))
(def person-pin (interop/react-factory PersonPin))
(def person-pin-circle (interop/react-factory PersonPinCircle))
(def person-pin-circle-outlined (interop/react-factory PersonPinCircleOutlined))
(def person-pin-circle-rounded (interop/react-factory PersonPinCircleRounded))
(def person-pin-circle-sharp (interop/react-factory PersonPinCircleSharp))
(def person-pin-circle-two-tone (interop/react-factory PersonPinCircleTwoTone))
(def person-pin-outlined (interop/react-factory PersonPinOutlined))
(def person-pin-rounded (interop/react-factory PersonPinRounded))
(def person-pin-sharp (interop/react-factory PersonPinSharp))
(def person-pin-two-tone (interop/react-factory PersonPinTwoTone))
(def person-rounded (interop/react-factory PersonRounded))
(def person-sharp (interop/react-factory PersonSharp))
(def person-two-tone (interop/react-factory PersonTwoTone))
(def pets (interop/react-factory Pets))
(def pets-outlined (interop/react-factory PetsOutlined))
(def pets-rounded (interop/react-factory PetsRounded))
(def pets-sharp (interop/react-factory PetsSharp))
(def pets-two-tone (interop/react-factory PetsTwoTone))
(def phone (interop/react-factory Phone))
(def phone-android (interop/react-factory PhoneAndroid))
(def phone-android-outlined (interop/react-factory PhoneAndroidOutlined))
(def phone-android-rounded (interop/react-factory PhoneAndroidRounded))
(def phone-android-sharp (interop/react-factory PhoneAndroidSharp))
(def phone-android-two-tone (interop/react-factory PhoneAndroidTwoTone))
(def phone-bluetooth-speaker (interop/react-factory PhoneBluetoothSpeaker))
(def phone-bluetooth-speaker-outlined (interop/react-factory PhoneBluetoothSpeakerOutlined))
(def phone-bluetooth-speaker-rounded (interop/react-factory PhoneBluetoothSpeakerRounded))
(def phone-bluetooth-speaker-sharp (interop/react-factory PhoneBluetoothSpeakerSharp))
(def phone-bluetooth-speaker-two-tone (interop/react-factory PhoneBluetoothSpeakerTwoTone))
(def phone-callback (interop/react-factory PhoneCallback))
(def phone-callback-outlined (interop/react-factory PhoneCallbackOutlined))
(def phone-callback-rounded (interop/react-factory PhoneCallbackRounded))
(def phone-callback-sharp (interop/react-factory PhoneCallbackSharp))
(def phone-callback-two-tone (interop/react-factory PhoneCallbackTwoTone))
(def phone-disabled (interop/react-factory PhoneDisabled))
(def phone-disabled-outlined (interop/react-factory PhoneDisabledOutlined))
(def phone-disabled-rounded (interop/react-factory PhoneDisabledRounded))
(def phone-disabled-sharp (interop/react-factory PhoneDisabledSharp))
(def phone-disabled-two-tone (interop/react-factory PhoneDisabledTwoTone))
(def phone-enabled (interop/react-factory PhoneEnabled))
(def phone-enabled-outlined (interop/react-factory PhoneEnabledOutlined))
(def phone-enabled-rounded (interop/react-factory PhoneEnabledRounded))
(def phone-enabled-sharp (interop/react-factory PhoneEnabledSharp))
(def phone-enabled-two-tone (interop/react-factory PhoneEnabledTwoTone))
(def phone-forwarded (interop/react-factory PhoneForwarded))
(def phone-forwarded-outlined (interop/react-factory PhoneForwardedOutlined))
(def phone-forwarded-rounded (interop/react-factory PhoneForwardedRounded))
(def phone-forwarded-sharp (interop/react-factory PhoneForwardedSharp))
(def phone-forwarded-two-tone (interop/react-factory PhoneForwardedTwoTone))
(def phone-in-talk (interop/react-factory PhoneInTalk))
(def phone-in-talk-outlined (interop/react-factory PhoneInTalkOutlined))
(def phone-in-talk-rounded (interop/react-factory PhoneInTalkRounded))
(def phone-in-talk-sharp (interop/react-factory PhoneInTalkSharp))
(def phone-in-talk-two-tone (interop/react-factory PhoneInTalkTwoTone))
(def phone-iphone (interop/react-factory PhoneIphone))
(def phone-iphone-outlined (interop/react-factory PhoneIphoneOutlined))
(def phone-iphone-rounded (interop/react-factory PhoneIphoneRounded))
(def phone-iphone-sharp (interop/react-factory PhoneIphoneSharp))
(def phone-iphone-two-tone (interop/react-factory PhoneIphoneTwoTone))
(def phonelink (interop/react-factory Phonelink))
(def phonelink-erase (interop/react-factory PhonelinkErase))
(def phonelink-erase-outlined (interop/react-factory PhonelinkEraseOutlined))
(def phonelink-erase-rounded (interop/react-factory PhonelinkEraseRounded))
(def phonelink-erase-sharp (interop/react-factory PhonelinkEraseSharp))
(def phonelink-erase-two-tone (interop/react-factory PhonelinkEraseTwoTone))
(def phonelink-lock (interop/react-factory PhonelinkLock))
(def phonelink-lock-outlined (interop/react-factory PhonelinkLockOutlined))
(def phonelink-lock-rounded (interop/react-factory PhonelinkLockRounded))
(def phonelink-lock-sharp (interop/react-factory PhonelinkLockSharp))
(def phonelink-lock-two-tone (interop/react-factory PhonelinkLockTwoTone))
(def phonelink-off (interop/react-factory PhonelinkOff))
(def phonelink-off-outlined (interop/react-factory PhonelinkOffOutlined))
(def phonelink-off-rounded (interop/react-factory PhonelinkOffRounded))
(def phonelink-off-sharp (interop/react-factory PhonelinkOffSharp))
(def phonelink-off-two-tone (interop/react-factory PhonelinkOffTwoTone))
(def phonelink-outlined (interop/react-factory PhonelinkOutlined))
(def phonelink-ring (interop/react-factory PhonelinkRing))
(def phonelink-ring-outlined (interop/react-factory PhonelinkRingOutlined))
(def phonelink-ring-rounded (interop/react-factory PhonelinkRingRounded))
(def phonelink-ring-sharp (interop/react-factory PhonelinkRingSharp))
(def phonelink-ring-two-tone (interop/react-factory PhonelinkRingTwoTone))
(def phonelink-rounded (interop/react-factory PhonelinkRounded))
(def phonelink-setup (interop/react-factory PhonelinkSetup))
(def phonelink-setup-outlined (interop/react-factory PhonelinkSetupOutlined))
(def phonelink-setup-rounded (interop/react-factory PhonelinkSetupRounded))
(def phonelink-setup-sharp (interop/react-factory PhonelinkSetupSharp))
(def phonelink-setup-two-tone (interop/react-factory PhonelinkSetupTwoTone))
(def phonelink-sharp (interop/react-factory PhonelinkSharp))
(def phonelink-two-tone (interop/react-factory PhonelinkTwoTone))
(def phone-locked (interop/react-factory PhoneLocked))
(def phone-locked-outlined (interop/react-factory PhoneLockedOutlined))
(def phone-locked-rounded (interop/react-factory PhoneLockedRounded))
(def phone-locked-sharp (interop/react-factory PhoneLockedSharp))
(def phone-locked-two-tone (interop/react-factory PhoneLockedTwoTone))
(def phone-missed (interop/react-factory PhoneMissed))
(def phone-missed-outlined (interop/react-factory PhoneMissedOutlined))
(def phone-missed-rounded (interop/react-factory PhoneMissedRounded))
(def phone-missed-sharp (interop/react-factory PhoneMissedSharp))
(def phone-missed-two-tone (interop/react-factory PhoneMissedTwoTone))
(def phone-outlined (interop/react-factory PhoneOutlined))
(def phone-paused (interop/react-factory PhonePaused))
(def phone-paused-outlined (interop/react-factory PhonePausedOutlined))
(def phone-paused-rounded (interop/react-factory PhonePausedRounded))
(def phone-paused-sharp (interop/react-factory PhonePausedSharp))
(def phone-paused-two-tone (interop/react-factory PhonePausedTwoTone))
(def phone-rounded (interop/react-factory PhoneRounded))
(def phone-sharp (interop/react-factory PhoneSharp))
(def phone-two-tone (interop/react-factory PhoneTwoTone))
(def photo (interop/react-factory Photo))
(def photo-album (interop/react-factory PhotoAlbum))
(def photo-album-outlined (interop/react-factory PhotoAlbumOutlined))
(def photo-album-rounded (interop/react-factory PhotoAlbumRounded))
(def photo-album-sharp (interop/react-factory PhotoAlbumSharp))
(def photo-album-two-tone (interop/react-factory PhotoAlbumTwoTone))
(def photo-camera (interop/react-factory PhotoCamera))
(def photo-camera-outlined (interop/react-factory PhotoCameraOutlined))
(def photo-camera-rounded (interop/react-factory PhotoCameraRounded))
(def photo-camera-sharp (interop/react-factory PhotoCameraSharp))
(def photo-camera-two-tone (interop/react-factory PhotoCameraTwoTone))
(def photo-filter (interop/react-factory PhotoFilter))
(def photo-filter-outlined (interop/react-factory PhotoFilterOutlined))
(def photo-filter-rounded (interop/react-factory PhotoFilterRounded))
(def photo-filter-sharp (interop/react-factory PhotoFilterSharp))
(def photo-filter-two-tone (interop/react-factory PhotoFilterTwoTone))
(def photo-library (interop/react-factory PhotoLibrary))
(def photo-library-outlined (interop/react-factory PhotoLibraryOutlined))
(def photo-library-rounded (interop/react-factory PhotoLibraryRounded))
(def photo-library-sharp (interop/react-factory PhotoLibrarySharp))
(def photo-library-two-tone (interop/react-factory PhotoLibraryTwoTone))
(def photo-outlined (interop/react-factory PhotoOutlined))
(def photo-rounded (interop/react-factory PhotoRounded))
(def photo-sharp (interop/react-factory PhotoSharp))
(def photo-size-select-actual (interop/react-factory PhotoSizeSelectActual))
(def photo-size-select-actual-outlined (interop/react-factory PhotoSizeSelectActualOutlined))
(def photo-size-select-actual-rounded (interop/react-factory PhotoSizeSelectActualRounded))
(def photo-size-select-actual-sharp (interop/react-factory PhotoSizeSelectActualSharp))
(def photo-size-select-actual-two-tone (interop/react-factory PhotoSizeSelectActualTwoTone))
(def photo-size-select-large (interop/react-factory PhotoSizeSelectLarge))
(def photo-size-select-large-outlined (interop/react-factory PhotoSizeSelectLargeOutlined))
(def photo-size-select-large-rounded (interop/react-factory PhotoSizeSelectLargeRounded))
(def photo-size-select-large-sharp (interop/react-factory PhotoSizeSelectLargeSharp))
(def photo-size-select-large-two-tone (interop/react-factory PhotoSizeSelectLargeTwoTone))
(def photo-size-select-small (interop/react-factory PhotoSizeSelectSmall))
(def photo-size-select-small-outlined (interop/react-factory PhotoSizeSelectSmallOutlined))
(def photo-size-select-small-rounded (interop/react-factory PhotoSizeSelectSmallRounded))
(def photo-size-select-small-sharp (interop/react-factory PhotoSizeSelectSmallSharp))
(def photo-size-select-small-two-tone (interop/react-factory PhotoSizeSelectSmallTwoTone))
(def photo-two-tone (interop/react-factory PhotoTwoTone))
(def picture-as-pdf (interop/react-factory PictureAsPdf))
(def picture-as-pdf-outlined (interop/react-factory PictureAsPdfOutlined))
(def picture-as-pdf-rounded (interop/react-factory PictureAsPdfRounded))
(def picture-as-pdf-sharp (interop/react-factory PictureAsPdfSharp))
(def picture-as-pdf-two-tone (interop/react-factory PictureAsPdfTwoTone))
(def picture-in-picture (interop/react-factory PictureInPicture))
(def picture-in-picture-alt (interop/react-factory PictureInPictureAlt))
(def picture-in-picture-alt-outlined (interop/react-factory PictureInPictureAltOutlined))
(def picture-in-picture-alt-rounded (interop/react-factory PictureInPictureAltRounded))
(def picture-in-picture-alt-sharp (interop/react-factory PictureInPictureAltSharp))
(def picture-in-picture-alt-two-tone (interop/react-factory PictureInPictureAltTwoTone))
(def picture-in-picture-outlined (interop/react-factory PictureInPictureOutlined))
(def picture-in-picture-rounded (interop/react-factory PictureInPictureRounded))
(def picture-in-picture-sharp (interop/react-factory PictureInPictureSharp))
(def picture-in-picture-two-tone (interop/react-factory PictureInPictureTwoTone))
(def pie-chart (interop/react-factory PieChart))
(def pie-chart-outlined (interop/react-factory PieChartOutlined))
(def pie-chart-rounded (interop/react-factory PieChartRounded))
(def pie-chart-sharp (interop/react-factory PieChartSharp))
(def pie-chart-two-tone (interop/react-factory PieChartTwoTone))
(def pin-drop (interop/react-factory PinDrop))
(def pin-drop-outlined (interop/react-factory PinDropOutlined))
(def pin-drop-rounded (interop/react-factory PinDropRounded))
(def pin-drop-sharp (interop/react-factory PinDropSharp))
(def pin-drop-two-tone (interop/react-factory PinDropTwoTone))
(def pinterest (interop/react-factory Pinterest))
(def place (interop/react-factory Place))
(def place-outlined (interop/react-factory PlaceOutlined))
(def place-rounded (interop/react-factory PlaceRounded))
(def place-sharp (interop/react-factory PlaceSharp))
(def place-two-tone (interop/react-factory PlaceTwoTone))
(def play-arrow (interop/react-factory PlayArrow))
(def play-arrow-outlined (interop/react-factory PlayArrowOutlined))
(def play-arrow-rounded (interop/react-factory PlayArrowRounded))
(def play-arrow-sharp (interop/react-factory PlayArrowSharp))
(def play-arrow-two-tone (interop/react-factory PlayArrowTwoTone))
(def play-circle-filled (interop/react-factory PlayCircleFilled))
(def play-circle-filled-outlined (interop/react-factory PlayCircleFilledOutlined))
(def play-circle-filled-rounded (interop/react-factory PlayCircleFilledRounded))
(def play-circle-filled-sharp (interop/react-factory PlayCircleFilledSharp))
(def play-circle-filled-two-tone (interop/react-factory PlayCircleFilledTwoTone))
(def play-circle-filled-white (interop/react-factory PlayCircleFilledWhite))
(def play-circle-filled-white-outlined (interop/react-factory PlayCircleFilledWhiteOutlined))
(def play-circle-filled-white-rounded (interop/react-factory PlayCircleFilledWhiteRounded))
(def play-circle-filled-white-sharp (interop/react-factory PlayCircleFilledWhiteSharp))
(def play-circle-filled-white-two-tone (interop/react-factory PlayCircleFilledWhiteTwoTone))
(def play-circle-outline (interop/react-factory PlayCircleOutline))
(def play-circle-outline-outlined (interop/react-factory PlayCircleOutlineOutlined))
(def play-circle-outline-rounded (interop/react-factory PlayCircleOutlineRounded))
(def play-circle-outline-sharp (interop/react-factory PlayCircleOutlineSharp))
(def play-circle-outline-two-tone (interop/react-factory PlayCircleOutlineTwoTone))
(def play-for-work (interop/react-factory PlayForWork))
(def play-for-work-outlined (interop/react-factory PlayForWorkOutlined))
(def play-for-work-rounded (interop/react-factory PlayForWorkRounded))
(def play-for-work-sharp (interop/react-factory PlayForWorkSharp))
(def play-for-work-two-tone (interop/react-factory PlayForWorkTwoTone))
(def playlist-add (interop/react-factory PlaylistAdd))
(def playlist-add-check (interop/react-factory PlaylistAddCheck))
(def playlist-add-check-outlined (interop/react-factory PlaylistAddCheckOutlined))
(def playlist-add-check-rounded (interop/react-factory PlaylistAddCheckRounded))
(def playlist-add-check-sharp (interop/react-factory PlaylistAddCheckSharp))
(def playlist-add-check-two-tone (interop/react-factory PlaylistAddCheckTwoTone))
(def playlist-add-outlined (interop/react-factory PlaylistAddOutlined))
(def playlist-add-rounded (interop/react-factory PlaylistAddRounded))
(def playlist-add-sharp (interop/react-factory PlaylistAddSharp))
(def playlist-add-two-tone (interop/react-factory PlaylistAddTwoTone))
(def playlist-play (interop/react-factory PlaylistPlay))
(def playlist-play-outlined (interop/react-factory PlaylistPlayOutlined))
(def playlist-play-rounded (interop/react-factory PlaylistPlayRounded))
(def playlist-play-sharp (interop/react-factory PlaylistPlaySharp))
(def playlist-play-two-tone (interop/react-factory PlaylistPlayTwoTone))
(def plus-one (interop/react-factory PlusOne))
(def plus-one-outlined (interop/react-factory PlusOneOutlined))
(def plus-one-rounded (interop/react-factory PlusOneRounded))
(def plus-one-sharp (interop/react-factory PlusOneSharp))
(def plus-one-two-tone (interop/react-factory PlusOneTwoTone))
(def policy (interop/react-factory Policy))
(def policy-outlined (interop/react-factory PolicyOutlined))
(def policy-rounded (interop/react-factory PolicyRounded))
(def policy-sharp (interop/react-factory PolicySharp))
(def policy-two-tone (interop/react-factory PolicyTwoTone))
(def poll (interop/react-factory Poll))
(def poll-outlined (interop/react-factory PollOutlined))
(def poll-rounded (interop/react-factory PollRounded))
(def poll-sharp (interop/react-factory PollSharp))
(def poll-two-tone (interop/react-factory PollTwoTone))
(def polymer (interop/react-factory Polymer))
(def polymer-outlined (interop/react-factory PolymerOutlined))
(def polymer-rounded (interop/react-factory PolymerRounded))
(def polymer-sharp (interop/react-factory PolymerSharp))
(def polymer-two-tone (interop/react-factory PolymerTwoTone))
(def pool (interop/react-factory Pool))
(def pool-outlined (interop/react-factory PoolOutlined))
(def pool-rounded (interop/react-factory PoolRounded))
(def pool-sharp (interop/react-factory PoolSharp))
(def pool-two-tone (interop/react-factory PoolTwoTone))
(def portable-wifi-off (interop/react-factory PortableWifiOff))
(def portable-wifi-off-outlined (interop/react-factory PortableWifiOffOutlined))
(def portable-wifi-off-rounded (interop/react-factory PortableWifiOffRounded))
(def portable-wifi-off-sharp (interop/react-factory PortableWifiOffSharp))
(def portable-wifi-off-two-tone (interop/react-factory PortableWifiOffTwoTone))
(def portrait (interop/react-factory Portrait))
(def portrait-outlined (interop/react-factory PortraitOutlined))
(def portrait-rounded (interop/react-factory PortraitRounded))
(def portrait-sharp (interop/react-factory PortraitSharp))
(def portrait-two-tone (interop/react-factory PortraitTwoTone))
(def post-add (interop/react-factory PostAdd))
(def post-add-outlined (interop/react-factory PostAddOutlined))
(def post-add-rounded (interop/react-factory PostAddRounded))
(def post-add-sharp (interop/react-factory PostAddSharp))
(def post-add-two-tone (interop/react-factory PostAddTwoTone))
(def power (interop/react-factory Power))
(def power-input (interop/react-factory PowerInput))
(def power-input-outlined (interop/react-factory PowerInputOutlined))
(def power-input-rounded (interop/react-factory PowerInputRounded))
(def power-input-sharp (interop/react-factory PowerInputSharp))
(def power-input-two-tone (interop/react-factory PowerInputTwoTone))
(def power-off (interop/react-factory PowerOff))
(def power-off-outlined (interop/react-factory PowerOffOutlined))
(def power-off-rounded (interop/react-factory PowerOffRounded))
(def power-off-sharp (interop/react-factory PowerOffSharp))
(def power-off-two-tone (interop/react-factory PowerOffTwoTone))
(def power-outlined (interop/react-factory PowerOutlined))
(def power-rounded (interop/react-factory PowerRounded))
(def power-settings-new (interop/react-factory PowerSettingsNew))
(def power-settings-new-outlined (interop/react-factory PowerSettingsNewOutlined))
(def power-settings-new-rounded (interop/react-factory PowerSettingsNewRounded))
(def power-settings-new-sharp (interop/react-factory PowerSettingsNewSharp))
(def power-settings-new-two-tone (interop/react-factory PowerSettingsNewTwoTone))
(def power-sharp (interop/react-factory PowerSharp))
(def power-two-tone (interop/react-factory PowerTwoTone))
(def pregnant-woman (interop/react-factory PregnantWoman))
(def pregnant-woman-outlined (interop/react-factory PregnantWomanOutlined))
(def pregnant-woman-rounded (interop/react-factory PregnantWomanRounded))
(def pregnant-woman-sharp (interop/react-factory PregnantWomanSharp))
(def pregnant-woman-two-tone (interop/react-factory PregnantWomanTwoTone))
(def present-to-all (interop/react-factory PresentToAll))
(def present-to-all-outlined (interop/react-factory PresentToAllOutlined))
(def present-to-all-rounded (interop/react-factory PresentToAllRounded))
(def present-to-all-sharp (interop/react-factory PresentToAllSharp))
(def present-to-all-two-tone (interop/react-factory PresentToAllTwoTone))
(def print (interop/react-factory Print))
(def print-disabled (interop/react-factory PrintDisabled))
(def print-disabled-outlined (interop/react-factory PrintDisabledOutlined))
(def print-disabled-rounded (interop/react-factory PrintDisabledRounded))
(def print-disabled-sharp (interop/react-factory PrintDisabledSharp))
(def print-disabled-two-tone (interop/react-factory PrintDisabledTwoTone))
(def print-outlined (interop/react-factory PrintOutlined))
(def print-rounded (interop/react-factory PrintRounded))
(def print-sharp (interop/react-factory PrintSharp))
(def print-two-tone (interop/react-factory PrintTwoTone))
(def priority-high (interop/react-factory PriorityHigh))
(def priority-high-outlined (interop/react-factory PriorityHighOutlined))
(def priority-high-rounded (interop/react-factory PriorityHighRounded))
(def priority-high-sharp (interop/react-factory PriorityHighSharp))
(def priority-high-two-tone (interop/react-factory PriorityHighTwoTone))
(def public (interop/react-factory Public))
(def public-outlined (interop/react-factory PublicOutlined))
(def public-rounded (interop/react-factory PublicRounded))
(def public-sharp (interop/react-factory PublicSharp))
(def public-two-tone (interop/react-factory PublicTwoTone))
(def publish (interop/react-factory Publish))
(def publish-outlined (interop/react-factory PublishOutlined))
(def publish-rounded (interop/react-factory PublishRounded))
(def publish-sharp (interop/react-factory PublishSharp))
(def publish-two-tone (interop/react-factory PublishTwoTone))
(def query-builder (interop/react-factory QueryBuilder))
(def query-builder-outlined (interop/react-factory QueryBuilderOutlined))
(def query-builder-rounded (interop/react-factory QueryBuilderRounded))
(def query-builder-sharp (interop/react-factory QueryBuilderSharp))
(def query-builder-two-tone (interop/react-factory QueryBuilderTwoTone))
(def question-answer (interop/react-factory QuestionAnswer))
(def question-answer-outlined (interop/react-factory QuestionAnswerOutlined))
(def question-answer-rounded (interop/react-factory QuestionAnswerRounded))
(def question-answer-sharp (interop/react-factory QuestionAnswerSharp))
(def question-answer-two-tone (interop/react-factory QuestionAnswerTwoTone))
(def queue (interop/react-factory Queue))
(def queue-music (interop/react-factory QueueMusic))
(def queue-music-outlined (interop/react-factory QueueMusicOutlined))
(def queue-music-rounded (interop/react-factory QueueMusicRounded))
(def queue-music-sharp (interop/react-factory QueueMusicSharp))
(def queue-music-two-tone (interop/react-factory QueueMusicTwoTone))
(def queue-outlined (interop/react-factory QueueOutlined))
(def queue-play-next (interop/react-factory QueuePlayNext))
(def queue-play-next-outlined (interop/react-factory QueuePlayNextOutlined))
(def queue-play-next-rounded (interop/react-factory QueuePlayNextRounded))
(def queue-play-next-sharp (interop/react-factory QueuePlayNextSharp))
(def queue-play-next-two-tone (interop/react-factory QueuePlayNextTwoTone))
(def queue-rounded (interop/react-factory QueueRounded))
(def queue-sharp (interop/react-factory QueueSharp))
(def queue-two-tone (interop/react-factory QueueTwoTone))
(def radio (interop/react-factory Radio))
(def radio-button-checked (interop/react-factory RadioButtonChecked))
(def radio-button-checked-outlined (interop/react-factory RadioButtonCheckedOutlined))
(def radio-button-checked-rounded (interop/react-factory RadioButtonCheckedRounded))
(def radio-button-checked-sharp (interop/react-factory RadioButtonCheckedSharp))
(def radio-button-checked-two-tone (interop/react-factory RadioButtonCheckedTwoTone))
(def radio-button-unchecked (interop/react-factory RadioButtonUnchecked))
(def radio-button-unchecked-outlined (interop/react-factory RadioButtonUncheckedOutlined))
(def radio-button-unchecked-rounded (interop/react-factory RadioButtonUncheckedRounded))
(def radio-button-unchecked-sharp (interop/react-factory RadioButtonUncheckedSharp))
(def radio-button-unchecked-two-tone (interop/react-factory RadioButtonUncheckedTwoTone))
(def radio-outlined (interop/react-factory RadioOutlined))
(def radio-rounded (interop/react-factory RadioRounded))
(def radio-sharp (interop/react-factory RadioSharp))
(def radio-two-tone (interop/react-factory RadioTwoTone))
(def rate-review (interop/react-factory RateReview))
(def rate-review-outlined (interop/react-factory RateReviewOutlined))
(def rate-review-rounded (interop/react-factory RateReviewRounded))
(def rate-review-sharp (interop/react-factory RateReviewSharp))
(def rate-review-two-tone (interop/react-factory RateReviewTwoTone))
(def receipt (interop/react-factory Receipt))
(def receipt-outlined (interop/react-factory ReceiptOutlined))
(def receipt-rounded (interop/react-factory ReceiptRounded))
(def receipt-sharp (interop/react-factory ReceiptSharp))
(def receipt-two-tone (interop/react-factory ReceiptTwoTone))
(def recent-actors (interop/react-factory RecentActors))
(def recent-actors-outlined (interop/react-factory RecentActorsOutlined))
(def recent-actors-rounded (interop/react-factory RecentActorsRounded))
(def recent-actors-sharp (interop/react-factory RecentActorsSharp))
(def recent-actors-two-tone (interop/react-factory RecentActorsTwoTone))
(def record-voice-over (interop/react-factory RecordVoiceOver))
(def record-voice-over-outlined (interop/react-factory RecordVoiceOverOutlined))
(def record-voice-over-rounded (interop/react-factory RecordVoiceOverRounded))
(def record-voice-over-sharp (interop/react-factory RecordVoiceOverSharp))
(def record-voice-over-two-tone (interop/react-factory RecordVoiceOverTwoTone))
(def reddit (interop/react-factory Reddit))
(def redeem (interop/react-factory Redeem))
(def redeem-outlined (interop/react-factory RedeemOutlined))
(def redeem-rounded (interop/react-factory RedeemRounded))
(def redeem-sharp (interop/react-factory RedeemSharp))
(def redeem-two-tone (interop/react-factory RedeemTwoTone))
(def redo (interop/react-factory Redo))
(def redo-outlined (interop/react-factory RedoOutlined))
(def redo-rounded (interop/react-factory RedoRounded))
(def redo-sharp (interop/react-factory RedoSharp))
(def redo-two-tone (interop/react-factory RedoTwoTone))
(def refresh (interop/react-factory Refresh))
(def refresh-outlined (interop/react-factory RefreshOutlined))
(def refresh-rounded (interop/react-factory RefreshRounded))
(def refresh-sharp (interop/react-factory RefreshSharp))
(def refresh-two-tone (interop/react-factory RefreshTwoTone))
(def remove (interop/react-factory Remove))
(def remove-circle (interop/react-factory RemoveCircle))
(def remove-circle-outline (interop/react-factory RemoveCircleOutline))
(def remove-circle-outlined (interop/react-factory RemoveCircleOutlined))
(def remove-circle-outline-outlined (interop/react-factory RemoveCircleOutlineOutlined))
(def remove-circle-outline-rounded (interop/react-factory RemoveCircleOutlineRounded))
(def remove-circle-outline-sharp (interop/react-factory RemoveCircleOutlineSharp))
(def remove-circle-outline-two-tone (interop/react-factory RemoveCircleOutlineTwoTone))
(def remove-circle-rounded (interop/react-factory RemoveCircleRounded))
(def remove-circle-sharp (interop/react-factory RemoveCircleSharp))
(def remove-circle-two-tone (interop/react-factory RemoveCircleTwoTone))
(def remove-from-queue (interop/react-factory RemoveFromQueue))
(def remove-from-queue-outlined (interop/react-factory RemoveFromQueueOutlined))
(def remove-from-queue-rounded (interop/react-factory RemoveFromQueueRounded))
(def remove-from-queue-sharp (interop/react-factory RemoveFromQueueSharp))
(def remove-from-queue-two-tone (interop/react-factory RemoveFromQueueTwoTone))
(def remove-outlined (interop/react-factory RemoveOutlined))
(def remove-red-eye (interop/react-factory RemoveRedEye))
(def remove-red-eye-outlined (interop/react-factory RemoveRedEyeOutlined))
(def remove-red-eye-rounded (interop/react-factory RemoveRedEyeRounded))
(def remove-red-eye-sharp (interop/react-factory RemoveRedEyeSharp))
(def remove-red-eye-two-tone (interop/react-factory RemoveRedEyeTwoTone))
(def remove-rounded (interop/react-factory RemoveRounded))
(def remove-sharp (interop/react-factory RemoveSharp))
(def remove-shopping-cart (interop/react-factory RemoveShoppingCart))
(def remove-shopping-cart-outlined (interop/react-factory RemoveShoppingCartOutlined))
(def remove-shopping-cart-rounded (interop/react-factory RemoveShoppingCartRounded))
(def remove-shopping-cart-sharp (interop/react-factory RemoveShoppingCartSharp))
(def remove-shopping-cart-two-tone (interop/react-factory RemoveShoppingCartTwoTone))
(def remove-two-tone (interop/react-factory RemoveTwoTone))
(def reorder (interop/react-factory Reorder))
(def reorder-outlined (interop/react-factory ReorderOutlined))
(def reorder-rounded (interop/react-factory ReorderRounded))
(def reorder-sharp (interop/react-factory ReorderSharp))
(def reorder-two-tone (interop/react-factory ReorderTwoTone))
(def repeat (interop/react-factory Repeat))
(def repeat-one (interop/react-factory RepeatOne))
(def repeat-one-outlined (interop/react-factory RepeatOneOutlined))
(def repeat-one-rounded (interop/react-factory RepeatOneRounded))
(def repeat-one-sharp (interop/react-factory RepeatOneSharp))
(def repeat-one-two-tone (interop/react-factory RepeatOneTwoTone))
(def repeat-outlined (interop/react-factory RepeatOutlined))
(def repeat-rounded (interop/react-factory RepeatRounded))
(def repeat-sharp (interop/react-factory RepeatSharp))
(def repeat-two-tone (interop/react-factory RepeatTwoTone))
(def replay (interop/react-factory Replay))
(def replay10 (interop/react-factory Replay10))
(def replay10-outlined (interop/react-factory Replay10Outlined))
(def replay10-rounded (interop/react-factory Replay10Rounded))
(def replay10-sharp (interop/react-factory Replay10Sharp))
(def replay10-two-tone (interop/react-factory Replay10TwoTone))
(def replay30 (interop/react-factory Replay30))
(def replay30-outlined (interop/react-factory Replay30Outlined))
(def replay30-rounded (interop/react-factory Replay30Rounded))
(def replay30-sharp (interop/react-factory Replay30Sharp))
(def replay30-two-tone (interop/react-factory Replay30TwoTone))
(def replay5 (interop/react-factory Replay5))
(def replay5-outlined (interop/react-factory Replay5Outlined))
(def replay5-rounded (interop/react-factory Replay5Rounded))
(def replay5-sharp (interop/react-factory Replay5Sharp))
(def replay5-two-tone (interop/react-factory Replay5TwoTone))
(def replay-outlined (interop/react-factory ReplayOutlined))
(def replay-rounded (interop/react-factory ReplayRounded))
(def replay-sharp (interop/react-factory ReplaySharp))
(def replay-two-tone (interop/react-factory ReplayTwoTone))
(def reply (interop/react-factory Reply))
(def reply-all (interop/react-factory ReplyAll))
(def reply-all-outlined (interop/react-factory ReplyAllOutlined))
(def reply-all-rounded (interop/react-factory ReplyAllRounded))
(def reply-all-sharp (interop/react-factory ReplyAllSharp))
(def reply-all-two-tone (interop/react-factory ReplyAllTwoTone))
(def reply-outlined (interop/react-factory ReplyOutlined))
(def reply-rounded (interop/react-factory ReplyRounded))
(def reply-sharp (interop/react-factory ReplySharp))
(def reply-two-tone (interop/react-factory ReplyTwoTone))
(def report (interop/react-factory Report))
(def report-off (interop/react-factory ReportOff))
(def report-off-outlined (interop/react-factory ReportOffOutlined))
(def report-off-rounded (interop/react-factory ReportOffRounded))
(def report-off-sharp (interop/react-factory ReportOffSharp))
(def report-off-two-tone (interop/react-factory ReportOffTwoTone))
(def report-outlined (interop/react-factory ReportOutlined))
(def report-problem (interop/react-factory ReportProblem))
(def report-problem-outlined (interop/react-factory ReportProblemOutlined))
(def report-problem-rounded (interop/react-factory ReportProblemRounded))
(def report-problem-sharp (interop/react-factory ReportProblemSharp))
(def report-problem-two-tone (interop/react-factory ReportProblemTwoTone))
(def report-rounded (interop/react-factory ReportRounded))
(def report-sharp (interop/react-factory ReportSharp))
(def report-two-tone (interop/react-factory ReportTwoTone))
(def restaurant (interop/react-factory Restaurant))
(def restaurant-menu (interop/react-factory RestaurantMenu))
(def restaurant-menu-outlined (interop/react-factory RestaurantMenuOutlined))
(def restaurant-menu-rounded (interop/react-factory RestaurantMenuRounded))
(def restaurant-menu-sharp (interop/react-factory RestaurantMenuSharp))
(def restaurant-menu-two-tone (interop/react-factory RestaurantMenuTwoTone))
(def restaurant-outlined (interop/react-factory RestaurantOutlined))
(def restaurant-rounded (interop/react-factory RestaurantRounded))
(def restaurant-sharp (interop/react-factory RestaurantSharp))
(def restaurant-two-tone (interop/react-factory RestaurantTwoTone))
(def restore (interop/react-factory Restore))
(def restore-from-trash (interop/react-factory RestoreFromTrash))
(def restore-from-trash-outlined (interop/react-factory RestoreFromTrashOutlined))
(def restore-from-trash-rounded (interop/react-factory RestoreFromTrashRounded))
(def restore-from-trash-sharp (interop/react-factory RestoreFromTrashSharp))
(def restore-from-trash-two-tone (interop/react-factory RestoreFromTrashTwoTone))
(def restore-outlined (interop/react-factory RestoreOutlined))
(def restore-page (interop/react-factory RestorePage))
(def restore-page-outlined (interop/react-factory RestorePageOutlined))
(def restore-page-rounded (interop/react-factory RestorePageRounded))
(def restore-page-sharp (interop/react-factory RestorePageSharp))
(def restore-page-two-tone (interop/react-factory RestorePageTwoTone))
(def restore-rounded (interop/react-factory RestoreRounded))
(def restore-sharp (interop/react-factory RestoreSharp))
(def restore-two-tone (interop/react-factory RestoreTwoTone))
(def ring-volume (interop/react-factory RingVolume))
(def ring-volume-outlined (interop/react-factory RingVolumeOutlined))
(def ring-volume-rounded (interop/react-factory RingVolumeRounded))
(def ring-volume-sharp (interop/react-factory RingVolumeSharp))
(def ring-volume-two-tone (interop/react-factory RingVolumeTwoTone))
(def room (interop/react-factory Room))
(def room-outlined (interop/react-factory RoomOutlined))
(def room-rounded (interop/react-factory RoomRounded))
(def room-service (interop/react-factory RoomService))
(def room-service-outlined (interop/react-factory RoomServiceOutlined))
(def room-service-rounded (interop/react-factory RoomServiceRounded))
(def room-service-sharp (interop/react-factory RoomServiceSharp))
(def room-service-two-tone (interop/react-factory RoomServiceTwoTone))
(def room-sharp (interop/react-factory RoomSharp))
(def room-two-tone (interop/react-factory RoomTwoTone))
(def rotate90-degrees-ccw (interop/react-factory Rotate90DegreesCcw))
(def rotate90-degrees-ccw-outlined (interop/react-factory Rotate90DegreesCcwOutlined))
(def rotate90-degrees-ccw-rounded (interop/react-factory Rotate90DegreesCcwRounded))
(def rotate90-degrees-ccw-sharp (interop/react-factory Rotate90DegreesCcwSharp))
(def rotate90-degrees-ccw-two-tone (interop/react-factory Rotate90DegreesCcwTwoTone))
(def rotate-left (interop/react-factory RotateLeft))
(def rotate-left-outlined (interop/react-factory RotateLeftOutlined))
(def rotate-left-rounded (interop/react-factory RotateLeftRounded))
(def rotate-left-sharp (interop/react-factory RotateLeftSharp))
(def rotate-left-two-tone (interop/react-factory RotateLeftTwoTone))
(def rotate-right (interop/react-factory RotateRight))
(def rotate-right-outlined (interop/react-factory RotateRightOutlined))
(def rotate-right-rounded (interop/react-factory RotateRightRounded))
(def rotate-right-sharp (interop/react-factory RotateRightSharp))
(def rotate-right-two-tone (interop/react-factory RotateRightTwoTone))
(def rounded-corner (interop/react-factory RoundedCorner))
(def rounded-corner-outlined (interop/react-factory RoundedCornerOutlined))
(def rounded-corner-rounded (interop/react-factory RoundedCornerRounded))
(def rounded-corner-sharp (interop/react-factory RoundedCornerSharp))
(def rounded-corner-two-tone (interop/react-factory RoundedCornerTwoTone))
(def router (interop/react-factory Router))
(def router-outlined (interop/react-factory RouterOutlined))
(def router-rounded (interop/react-factory RouterRounded))
(def router-sharp (interop/react-factory RouterSharp))
(def router-two-tone (interop/react-factory RouterTwoTone))
(def rowing (interop/react-factory Rowing))
(def rowing-outlined (interop/react-factory RowingOutlined))
(def rowing-rounded (interop/react-factory RowingRounded))
(def rowing-sharp (interop/react-factory RowingSharp))
(def rowing-two-tone (interop/react-factory RowingTwoTone))
(def rss-feed (interop/react-factory RssFeed))
(def rss-feed-outlined (interop/react-factory RssFeedOutlined))
(def rss-feed-rounded (interop/react-factory RssFeedRounded))
(def rss-feed-sharp (interop/react-factory RssFeedSharp))
(def rss-feed-two-tone (interop/react-factory RssFeedTwoTone))
(def rv-hookup (interop/react-factory RvHookup))
(def rv-hookup-outlined (interop/react-factory RvHookupOutlined))
(def rv-hookup-rounded (interop/react-factory RvHookupRounded))
(def rv-hookup-sharp (interop/react-factory RvHookupSharp))
(def rv-hookup-two-tone (interop/react-factory RvHookupTwoTone))
(def satellite (interop/react-factory Satellite))
(def satellite-outlined (interop/react-factory SatelliteOutlined))
(def satellite-rounded (interop/react-factory SatelliteRounded))
(def satellite-sharp (interop/react-factory SatelliteSharp))
(def satellite-two-tone (interop/react-factory SatelliteTwoTone))
(def save (interop/react-factory Save))
(def save-alt (interop/react-factory SaveAlt))
(def save-alt-outlined (interop/react-factory SaveAltOutlined))
(def save-alt-rounded (interop/react-factory SaveAltRounded))
(def save-alt-sharp (interop/react-factory SaveAltSharp))
(def save-alt-two-tone (interop/react-factory SaveAltTwoTone))
(def save-outlined (interop/react-factory SaveOutlined))
(def save-rounded (interop/react-factory SaveRounded))
(def save-sharp (interop/react-factory SaveSharp))
(def save-two-tone (interop/react-factory SaveTwoTone))
(def scanner (interop/react-factory Scanner))
(def scanner-outlined (interop/react-factory ScannerOutlined))
(def scanner-rounded (interop/react-factory ScannerRounded))
(def scanner-sharp (interop/react-factory ScannerSharp))
(def scanner-two-tone (interop/react-factory ScannerTwoTone))
(def scatter-plot (interop/react-factory ScatterPlot))
(def scatter-plot-outlined (interop/react-factory ScatterPlotOutlined))
(def scatter-plot-rounded (interop/react-factory ScatterPlotRounded))
(def scatter-plot-sharp (interop/react-factory ScatterPlotSharp))
(def scatter-plot-two-tone (interop/react-factory ScatterPlotTwoTone))
(def schedule (interop/react-factory Schedule))
(def schedule-outlined (interop/react-factory ScheduleOutlined))
(def schedule-rounded (interop/react-factory ScheduleRounded))
(def schedule-sharp (interop/react-factory ScheduleSharp))
(def schedule-two-tone (interop/react-factory ScheduleTwoTone))
(def school (interop/react-factory School))
(def school-outlined (interop/react-factory SchoolOutlined))
(def school-rounded (interop/react-factory SchoolRounded))
(def school-sharp (interop/react-factory SchoolSharp))
(def school-two-tone (interop/react-factory SchoolTwoTone))
(def score (interop/react-factory Score))
(def score-outlined (interop/react-factory ScoreOutlined))
(def score-rounded (interop/react-factory ScoreRounded))
(def score-sharp (interop/react-factory ScoreSharp))
(def score-two-tone (interop/react-factory ScoreTwoTone))
(def screen-lock-landscape (interop/react-factory ScreenLockLandscape))
(def screen-lock-landscape-outlined (interop/react-factory ScreenLockLandscapeOutlined))
(def screen-lock-landscape-rounded (interop/react-factory ScreenLockLandscapeRounded))
(def screen-lock-landscape-sharp (interop/react-factory ScreenLockLandscapeSharp))
(def screen-lock-landscape-two-tone (interop/react-factory ScreenLockLandscapeTwoTone))
(def screen-lock-portrait (interop/react-factory ScreenLockPortrait))
(def screen-lock-portrait-outlined (interop/react-factory ScreenLockPortraitOutlined))
(def screen-lock-portrait-rounded (interop/react-factory ScreenLockPortraitRounded))
(def screen-lock-portrait-sharp (interop/react-factory ScreenLockPortraitSharp))
(def screen-lock-portrait-two-tone (interop/react-factory ScreenLockPortraitTwoTone))
(def screen-lock-rotation (interop/react-factory ScreenLockRotation))
(def screen-lock-rotation-outlined (interop/react-factory ScreenLockRotationOutlined))
(def screen-lock-rotation-rounded (interop/react-factory ScreenLockRotationRounded))
(def screen-lock-rotation-sharp (interop/react-factory ScreenLockRotationSharp))
(def screen-lock-rotation-two-tone (interop/react-factory ScreenLockRotationTwoTone))
(def screen-rotation (interop/react-factory ScreenRotation))
(def screen-rotation-outlined (interop/react-factory ScreenRotationOutlined))
(def screen-rotation-rounded (interop/react-factory ScreenRotationRounded))
(def screen-rotation-sharp (interop/react-factory ScreenRotationSharp))
(def screen-rotation-two-tone (interop/react-factory ScreenRotationTwoTone))
(def screen-share (interop/react-factory ScreenShare))
(def screen-share-outlined (interop/react-factory ScreenShareOutlined))
(def screen-share-rounded (interop/react-factory ScreenShareRounded))
(def screen-share-sharp (interop/react-factory ScreenShareSharp))
(def screen-share-two-tone (interop/react-factory ScreenShareTwoTone))
(def sd-card (interop/react-factory SdCard))
(def sd-card-outlined (interop/react-factory SdCardOutlined))
(def sd-card-rounded (interop/react-factory SdCardRounded))
(def sd-card-sharp (interop/react-factory SdCardSharp))
(def sd-card-two-tone (interop/react-factory SdCardTwoTone))
(def sd-storage (interop/react-factory SdStorage))
(def sd-storage-outlined (interop/react-factory SdStorageOutlined))
(def sd-storage-rounded (interop/react-factory SdStorageRounded))
(def sd-storage-sharp (interop/react-factory SdStorageSharp))
(def sd-storage-two-tone (interop/react-factory SdStorageTwoTone))
(def search (interop/react-factory Search))
(def search-outlined (interop/react-factory SearchOutlined))
(def search-rounded (interop/react-factory SearchRounded))
(def search-sharp (interop/react-factory SearchSharp))
(def search-two-tone (interop/react-factory SearchTwoTone))
(def security (interop/react-factory Security))
(def security-outlined (interop/react-factory SecurityOutlined))
(def security-rounded (interop/react-factory SecurityRounded))
(def security-sharp (interop/react-factory SecuritySharp))
(def security-two-tone (interop/react-factory SecurityTwoTone))
(def select-all (interop/react-factory SelectAll))
(def select-all-outlined (interop/react-factory SelectAllOutlined))
(def select-all-rounded (interop/react-factory SelectAllRounded))
(def select-all-sharp (interop/react-factory SelectAllSharp))
(def select-all-two-tone (interop/react-factory SelectAllTwoTone))
(def send (interop/react-factory Send))
(def send-outlined (interop/react-factory SendOutlined))
(def send-rounded (interop/react-factory SendRounded))
(def send-sharp (interop/react-factory SendSharp))
(def send-two-tone (interop/react-factory SendTwoTone))
(def sentiment-dissatisfied (interop/react-factory SentimentDissatisfied))
(def sentiment-dissatisfied-outlined (interop/react-factory SentimentDissatisfiedOutlined))
(def sentiment-dissatisfied-rounded (interop/react-factory SentimentDissatisfiedRounded))
(def sentiment-dissatisfied-sharp (interop/react-factory SentimentDissatisfiedSharp))
(def sentiment-dissatisfied-two-tone (interop/react-factory SentimentDissatisfiedTwoTone))
(def sentiment-satisfied (interop/react-factory SentimentSatisfied))
(def sentiment-satisfied-alt (interop/react-factory SentimentSatisfiedAlt))
(def sentiment-satisfied-alt-outlined (interop/react-factory SentimentSatisfiedAltOutlined))
(def sentiment-satisfied-alt-rounded (interop/react-factory SentimentSatisfiedAltRounded))
(def sentiment-satisfied-alt-sharp (interop/react-factory SentimentSatisfiedAltSharp))
(def sentiment-satisfied-alt-two-tone (interop/react-factory SentimentSatisfiedAltTwoTone))
(def sentiment-satisfied-outlined (interop/react-factory SentimentSatisfiedOutlined))
(def sentiment-satisfied-rounded (interop/react-factory SentimentSatisfiedRounded))
(def sentiment-satisfied-sharp (interop/react-factory SentimentSatisfiedSharp))
(def sentiment-satisfied-two-tone (interop/react-factory SentimentSatisfiedTwoTone))
(def sentiment-very-dissatisfied (interop/react-factory SentimentVeryDissatisfied))
(def sentiment-very-dissatisfied-outlined (interop/react-factory SentimentVeryDissatisfiedOutlined))
(def sentiment-very-dissatisfied-rounded (interop/react-factory SentimentVeryDissatisfiedRounded))
(def sentiment-very-dissatisfied-sharp (interop/react-factory SentimentVeryDissatisfiedSharp))
(def sentiment-very-dissatisfied-two-tone (interop/react-factory SentimentVeryDissatisfiedTwoTone))
(def sentiment-very-satisfied (interop/react-factory SentimentVerySatisfied))
(def sentiment-very-satisfied-outlined (interop/react-factory SentimentVerySatisfiedOutlined))
(def sentiment-very-satisfied-rounded (interop/react-factory SentimentVerySatisfiedRounded))
(def sentiment-very-satisfied-sharp (interop/react-factory SentimentVerySatisfiedSharp))
(def sentiment-very-satisfied-two-tone (interop/react-factory SentimentVerySatisfiedTwoTone))
(def settings (interop/react-factory Settings))
(def settings-applications (interop/react-factory SettingsApplications))
(def settings-applications-outlined (interop/react-factory SettingsApplicationsOutlined))
(def settings-applications-rounded (interop/react-factory SettingsApplicationsRounded))
(def settings-applications-sharp (interop/react-factory SettingsApplicationsSharp))
(def settings-applications-two-tone (interop/react-factory SettingsApplicationsTwoTone))
(def settings-backup-restore (interop/react-factory SettingsBackupRestore))
(def settings-backup-restore-outlined (interop/react-factory SettingsBackupRestoreOutlined))
(def settings-backup-restore-rounded (interop/react-factory SettingsBackupRestoreRounded))
(def settings-backup-restore-sharp (interop/react-factory SettingsBackupRestoreSharp))
(def settings-backup-restore-two-tone (interop/react-factory SettingsBackupRestoreTwoTone))
(def settings-bluetooth (interop/react-factory SettingsBluetooth))
(def settings-bluetooth-outlined (interop/react-factory SettingsBluetoothOutlined))
(def settings-bluetooth-rounded (interop/react-factory SettingsBluetoothRounded))
(def settings-bluetooth-sharp (interop/react-factory SettingsBluetoothSharp))
(def settings-bluetooth-two-tone (interop/react-factory SettingsBluetoothTwoTone))
(def settings-brightness (interop/react-factory SettingsBrightness))
(def settings-brightness-outlined (interop/react-factory SettingsBrightnessOutlined))
(def settings-brightness-rounded (interop/react-factory SettingsBrightnessRounded))
(def settings-brightness-sharp (interop/react-factory SettingsBrightnessSharp))
(def settings-brightness-two-tone (interop/react-factory SettingsBrightnessTwoTone))
(def settings-cell (interop/react-factory SettingsCell))
(def settings-cell-outlined (interop/react-factory SettingsCellOutlined))
(def settings-cell-rounded (interop/react-factory SettingsCellRounded))
(def settings-cell-sharp (interop/react-factory SettingsCellSharp))
(def settings-cell-two-tone (interop/react-factory SettingsCellTwoTone))
(def settings-ethernet (interop/react-factory SettingsEthernet))
(def settings-ethernet-outlined (interop/react-factory SettingsEthernetOutlined))
(def settings-ethernet-rounded (interop/react-factory SettingsEthernetRounded))
(def settings-ethernet-sharp (interop/react-factory SettingsEthernetSharp))
(def settings-ethernet-two-tone (interop/react-factory SettingsEthernetTwoTone))
(def settings-input-antenna (interop/react-factory SettingsInputAntenna))
(def settings-input-antenna-outlined (interop/react-factory SettingsInputAntennaOutlined))
(def settings-input-antenna-rounded (interop/react-factory SettingsInputAntennaRounded))
(def settings-input-antenna-sharp (interop/react-factory SettingsInputAntennaSharp))
(def settings-input-antenna-two-tone (interop/react-factory SettingsInputAntennaTwoTone))
(def settings-input-component (interop/react-factory SettingsInputComponent))
(def settings-input-component-outlined (interop/react-factory SettingsInputComponentOutlined))
(def settings-input-component-rounded (interop/react-factory SettingsInputComponentRounded))
(def settings-input-component-sharp (interop/react-factory SettingsInputComponentSharp))
(def settings-input-component-two-tone (interop/react-factory SettingsInputComponentTwoTone))
(def settings-input-composite (interop/react-factory SettingsInputComposite))
(def settings-input-composite-outlined (interop/react-factory SettingsInputCompositeOutlined))
(def settings-input-composite-rounded (interop/react-factory SettingsInputCompositeRounded))
(def settings-input-composite-sharp (interop/react-factory SettingsInputCompositeSharp))
(def settings-input-composite-two-tone (interop/react-factory SettingsInputCompositeTwoTone))
(def settings-input-hdmi (interop/react-factory SettingsInputHdmi))
(def settings-input-hdmi-outlined (interop/react-factory SettingsInputHdmiOutlined))
(def settings-input-hdmi-rounded (interop/react-factory SettingsInputHdmiRounded))
(def settings-input-hdmi-sharp (interop/react-factory SettingsInputHdmiSharp))
(def settings-input-hdmi-two-tone (interop/react-factory SettingsInputHdmiTwoTone))
(def settings-input-svideo (interop/react-factory SettingsInputSvideo))
(def settings-input-svideo-outlined (interop/react-factory SettingsInputSvideoOutlined))
(def settings-input-svideo-rounded (interop/react-factory SettingsInputSvideoRounded))
(def settings-input-svideo-sharp (interop/react-factory SettingsInputSvideoSharp))
(def settings-input-svideo-two-tone (interop/react-factory SettingsInputSvideoTwoTone))
(def settings-outlined (interop/react-factory SettingsOutlined))
(def settings-overscan (interop/react-factory SettingsOverscan))
(def settings-overscan-outlined (interop/react-factory SettingsOverscanOutlined))
(def settings-overscan-rounded (interop/react-factory SettingsOverscanRounded))
(def settings-overscan-sharp (interop/react-factory SettingsOverscanSharp))
(def settings-overscan-two-tone (interop/react-factory SettingsOverscanTwoTone))
(def settings-phone (interop/react-factory SettingsPhone))
(def settings-phone-outlined (interop/react-factory SettingsPhoneOutlined))
(def settings-phone-rounded (interop/react-factory SettingsPhoneRounded))
(def settings-phone-sharp (interop/react-factory SettingsPhoneSharp))
(def settings-phone-two-tone (interop/react-factory SettingsPhoneTwoTone))
(def settings-power (interop/react-factory SettingsPower))
(def settings-power-outlined (interop/react-factory SettingsPowerOutlined))
(def settings-power-rounded (interop/react-factory SettingsPowerRounded))
(def settings-power-sharp (interop/react-factory SettingsPowerSharp))
(def settings-power-two-tone (interop/react-factory SettingsPowerTwoTone))
(def settings-remote (interop/react-factory SettingsRemote))
(def settings-remote-outlined (interop/react-factory SettingsRemoteOutlined))
(def settings-remote-rounded (interop/react-factory SettingsRemoteRounded))
(def settings-remote-sharp (interop/react-factory SettingsRemoteSharp))
(def settings-remote-two-tone (interop/react-factory SettingsRemoteTwoTone))
(def settings-rounded (interop/react-factory SettingsRounded))
(def settings-sharp (interop/react-factory SettingsSharp))
(def settings-system-daydream (interop/react-factory SettingsSystemDaydream))
(def settings-system-daydream-outlined (interop/react-factory SettingsSystemDaydreamOutlined))
(def settings-system-daydream-rounded (interop/react-factory SettingsSystemDaydreamRounded))
(def settings-system-daydream-sharp (interop/react-factory SettingsSystemDaydreamSharp))
(def settings-system-daydream-two-tone (interop/react-factory SettingsSystemDaydreamTwoTone))
(def settings-two-tone (interop/react-factory SettingsTwoTone))
(def settings-voice (interop/react-factory SettingsVoice))
(def settings-voice-outlined (interop/react-factory SettingsVoiceOutlined))
(def settings-voice-rounded (interop/react-factory SettingsVoiceRounded))
(def settings-voice-sharp (interop/react-factory SettingsVoiceSharp))
(def settings-voice-two-tone (interop/react-factory SettingsVoiceTwoTone))
(def share (interop/react-factory Share))
(def share-outlined (interop/react-factory ShareOutlined))
(def share-rounded (interop/react-factory ShareRounded))
(def share-sharp (interop/react-factory ShareSharp))
(def share-two-tone (interop/react-factory ShareTwoTone))
(def shop (interop/react-factory Shop))
(def shop-outlined (interop/react-factory ShopOutlined))
(def shopping-basket (interop/react-factory ShoppingBasket))
(def shopping-basket-outlined (interop/react-factory ShoppingBasketOutlined))
(def shopping-basket-rounded (interop/react-factory ShoppingBasketRounded))
(def shopping-basket-sharp (interop/react-factory ShoppingBasketSharp))
(def shopping-basket-two-tone (interop/react-factory ShoppingBasketTwoTone))
(def shopping-cart (interop/react-factory ShoppingCart))
(def shopping-cart-outlined (interop/react-factory ShoppingCartOutlined))
(def shopping-cart-rounded (interop/react-factory ShoppingCartRounded))
(def shopping-cart-sharp (interop/react-factory ShoppingCartSharp))
(def shopping-cart-two-tone (interop/react-factory ShoppingCartTwoTone))
(def shop-rounded (interop/react-factory ShopRounded))
(def shop-sharp (interop/react-factory ShopSharp))
(def shop-two (interop/react-factory ShopTwo))
(def shop-two-outlined (interop/react-factory ShopTwoOutlined))
(def shop-two-rounded (interop/react-factory ShopTwoRounded))
(def shop-two-sharp (interop/react-factory ShopTwoSharp))
(def shop-two-tone (interop/react-factory ShopTwoTone))
(def shop-two-two-tone (interop/react-factory ShopTwoTwoTone))
(def short-text (interop/react-factory ShortText))
(def short-text-outlined (interop/react-factory ShortTextOutlined))
(def short-text-rounded (interop/react-factory ShortTextRounded))
(def short-text-sharp (interop/react-factory ShortTextSharp))
(def short-text-two-tone (interop/react-factory ShortTextTwoTone))
(def show-chart (interop/react-factory ShowChart))
(def show-chart-outlined (interop/react-factory ShowChartOutlined))
(def show-chart-rounded (interop/react-factory ShowChartRounded))
(def show-chart-sharp (interop/react-factory ShowChartSharp))
(def show-chart-two-tone (interop/react-factory ShowChartTwoTone))
(def shuffle (interop/react-factory Shuffle))
(def shuffle-outlined (interop/react-factory ShuffleOutlined))
(def shuffle-rounded (interop/react-factory ShuffleRounded))
(def shuffle-sharp (interop/react-factory ShuffleSharp))
(def shuffle-two-tone (interop/react-factory ShuffleTwoTone))
(def shutter-speed (interop/react-factory ShutterSpeed))
(def shutter-speed-outlined (interop/react-factory ShutterSpeedOutlined))
(def shutter-speed-rounded (interop/react-factory ShutterSpeedRounded))
(def shutter-speed-sharp (interop/react-factory ShutterSpeedSharp))
(def shutter-speed-two-tone (interop/react-factory ShutterSpeedTwoTone))
(def signal-cellular0-bar (interop/react-factory SignalCellular0Bar))
(def signal-cellular0-bar-outlined (interop/react-factory SignalCellular0BarOutlined))
(def signal-cellular0-bar-rounded (interop/react-factory SignalCellular0BarRounded))
(def signal-cellular0-bar-sharp (interop/react-factory SignalCellular0BarSharp))
(def signal-cellular0-bar-two-tone (interop/react-factory SignalCellular0BarTwoTone))
(def signal-cellular1-bar (interop/react-factory SignalCellular1Bar))
(def signal-cellular1-bar-outlined (interop/react-factory SignalCellular1BarOutlined))
(def signal-cellular1-bar-rounded (interop/react-factory SignalCellular1BarRounded))
(def signal-cellular1-bar-sharp (interop/react-factory SignalCellular1BarSharp))
(def signal-cellular1-bar-two-tone (interop/react-factory SignalCellular1BarTwoTone))
(def signal-cellular2-bar (interop/react-factory SignalCellular2Bar))
(def signal-cellular2-bar-outlined (interop/react-factory SignalCellular2BarOutlined))
(def signal-cellular2-bar-rounded (interop/react-factory SignalCellular2BarRounded))
(def signal-cellular2-bar-sharp (interop/react-factory SignalCellular2BarSharp))
(def signal-cellular2-bar-two-tone (interop/react-factory SignalCellular2BarTwoTone))
(def signal-cellular3-bar (interop/react-factory SignalCellular3Bar))
(def signal-cellular3-bar-outlined (interop/react-factory SignalCellular3BarOutlined))
(def signal-cellular3-bar-rounded (interop/react-factory SignalCellular3BarRounded))
(def signal-cellular3-bar-sharp (interop/react-factory SignalCellular3BarSharp))
(def signal-cellular3-bar-two-tone (interop/react-factory SignalCellular3BarTwoTone))
(def signal-cellular4-bar (interop/react-factory SignalCellular4Bar))
(def signal-cellular4-bar-outlined (interop/react-factory SignalCellular4BarOutlined))
(def signal-cellular4-bar-rounded (interop/react-factory SignalCellular4BarRounded))
(def signal-cellular4-bar-sharp (interop/react-factory SignalCellular4BarSharp))
(def signal-cellular4-bar-two-tone (interop/react-factory SignalCellular4BarTwoTone))
(def signal-cellular-alt (interop/react-factory SignalCellularAlt))
(def signal-cellular-alt-outlined (interop/react-factory SignalCellularAltOutlined))
(def signal-cellular-alt-rounded (interop/react-factory SignalCellularAltRounded))
(def signal-cellular-alt-sharp (interop/react-factory SignalCellularAltSharp))
(def signal-cellular-alt-two-tone (interop/react-factory SignalCellularAltTwoTone))
(def signal-cellular-connected-no-internet0-bar (interop/react-factory SignalCellularConnectedNoInternet0Bar))
(def signal-cellular-connected-no-internet0-bar-outlined (interop/react-factory SignalCellularConnectedNoInternet0BarOutlined))
(def signal-cellular-connected-no-internet0-bar-rounded (interop/react-factory SignalCellularConnectedNoInternet0BarRounded))
(def signal-cellular-connected-no-internet0-bar-sharp (interop/react-factory SignalCellularConnectedNoInternet0BarSharp))
(def signal-cellular-connected-no-internet0-bar-two-tone (interop/react-factory SignalCellularConnectedNoInternet0BarTwoTone))
(def signal-cellular-connected-no-internet1-bar (interop/react-factory SignalCellularConnectedNoInternet1Bar))
(def signal-cellular-connected-no-internet1-bar-outlined (interop/react-factory SignalCellularConnectedNoInternet1BarOutlined))
(def signal-cellular-connected-no-internet1-bar-rounded (interop/react-factory SignalCellularConnectedNoInternet1BarRounded))
(def signal-cellular-connected-no-internet1-bar-sharp (interop/react-factory SignalCellularConnectedNoInternet1BarSharp))
(def signal-cellular-connected-no-internet1-bar-two-tone (interop/react-factory SignalCellularConnectedNoInternet1BarTwoTone))
(def signal-cellular-connected-no-internet2-bar (interop/react-factory SignalCellularConnectedNoInternet2Bar))
(def signal-cellular-connected-no-internet2-bar-outlined (interop/react-factory SignalCellularConnectedNoInternet2BarOutlined))
(def signal-cellular-connected-no-internet2-bar-rounded (interop/react-factory SignalCellularConnectedNoInternet2BarRounded))
(def signal-cellular-connected-no-internet2-bar-sharp (interop/react-factory SignalCellularConnectedNoInternet2BarSharp))
(def signal-cellular-connected-no-internet2-bar-two-tone (interop/react-factory SignalCellularConnectedNoInternet2BarTwoTone))
(def signal-cellular-connected-no-internet3-bar (interop/react-factory SignalCellularConnectedNoInternet3Bar))
(def signal-cellular-connected-no-internet3-bar-outlined (interop/react-factory SignalCellularConnectedNoInternet3BarOutlined))
(def signal-cellular-connected-no-internet3-bar-rounded (interop/react-factory SignalCellularConnectedNoInternet3BarRounded))
(def signal-cellular-connected-no-internet3-bar-sharp (interop/react-factory SignalCellularConnectedNoInternet3BarSharp))
(def signal-cellular-connected-no-internet3-bar-two-tone (interop/react-factory SignalCellularConnectedNoInternet3BarTwoTone))
(def signal-cellular-connected-no-internet4-bar (interop/react-factory SignalCellularConnectedNoInternet4Bar))
(def signal-cellular-connected-no-internet4-bar-outlined (interop/react-factory SignalCellularConnectedNoInternet4BarOutlined))
(def signal-cellular-connected-no-internet4-bar-rounded (interop/react-factory SignalCellularConnectedNoInternet4BarRounded))
(def signal-cellular-connected-no-internet4-bar-sharp (interop/react-factory SignalCellularConnectedNoInternet4BarSharp))
(def signal-cellular-connected-no-internet4-bar-two-tone (interop/react-factory SignalCellularConnectedNoInternet4BarTwoTone))
(def signal-cellular-no-sim (interop/react-factory SignalCellularNoSim))
(def signal-cellular-no-sim-outlined (interop/react-factory SignalCellularNoSimOutlined))
(def signal-cellular-no-sim-rounded (interop/react-factory SignalCellularNoSimRounded))
(def signal-cellular-no-sim-sharp (interop/react-factory SignalCellularNoSimSharp))
(def signal-cellular-no-sim-two-tone (interop/react-factory SignalCellularNoSimTwoTone))
(def signal-cellular-null (interop/react-factory SignalCellularNull))
(def signal-cellular-null-outlined (interop/react-factory SignalCellularNullOutlined))
(def signal-cellular-null-rounded (interop/react-factory SignalCellularNullRounded))
(def signal-cellular-null-sharp (interop/react-factory SignalCellularNullSharp))
(def signal-cellular-null-two-tone (interop/react-factory SignalCellularNullTwoTone))
(def signal-cellular-off (interop/react-factory SignalCellularOff))
(def signal-cellular-off-outlined (interop/react-factory SignalCellularOffOutlined))
(def signal-cellular-off-rounded (interop/react-factory SignalCellularOffRounded))
(def signal-cellular-off-sharp (interop/react-factory SignalCellularOffSharp))
(def signal-cellular-off-two-tone (interop/react-factory SignalCellularOffTwoTone))
(def signal-wifi0-bar (interop/react-factory SignalWifi0Bar))
(def signal-wifi0-bar-outlined (interop/react-factory SignalWifi0BarOutlined))
(def signal-wifi0-bar-rounded (interop/react-factory SignalWifi0BarRounded))
(def signal-wifi0-bar-sharp (interop/react-factory SignalWifi0BarSharp))
(def signal-wifi0-bar-two-tone (interop/react-factory SignalWifi0BarTwoTone))
(def signal-wifi1-bar (interop/react-factory SignalWifi1Bar))
(def signal-wifi1-bar-lock (interop/react-factory SignalWifi1BarLock))
(def signal-wifi1-bar-lock-outlined (interop/react-factory SignalWifi1BarLockOutlined))
(def signal-wifi1-bar-lock-rounded (interop/react-factory SignalWifi1BarLockRounded))
(def signal-wifi1-bar-lock-sharp (interop/react-factory SignalWifi1BarLockSharp))
(def signal-wifi1-bar-lock-two-tone (interop/react-factory SignalWifi1BarLockTwoTone))
(def signal-wifi1-bar-outlined (interop/react-factory SignalWifi1BarOutlined))
(def signal-wifi1-bar-rounded (interop/react-factory SignalWifi1BarRounded))
(def signal-wifi1-bar-sharp (interop/react-factory SignalWifi1BarSharp))
(def signal-wifi1-bar-two-tone (interop/react-factory SignalWifi1BarTwoTone))
(def signal-wifi2-bar (interop/react-factory SignalWifi2Bar))
(def signal-wifi2-bar-lock (interop/react-factory SignalWifi2BarLock))
(def signal-wifi2-bar-lock-outlined (interop/react-factory SignalWifi2BarLockOutlined))
(def signal-wifi2-bar-lock-rounded (interop/react-factory SignalWifi2BarLockRounded))
(def signal-wifi2-bar-lock-sharp (interop/react-factory SignalWifi2BarLockSharp))
(def signal-wifi2-bar-lock-two-tone (interop/react-factory SignalWifi2BarLockTwoTone))
(def signal-wifi2-bar-outlined (interop/react-factory SignalWifi2BarOutlined))
(def signal-wifi2-bar-rounded (interop/react-factory SignalWifi2BarRounded))
(def signal-wifi2-bar-sharp (interop/react-factory SignalWifi2BarSharp))
(def signal-wifi2-bar-two-tone (interop/react-factory SignalWifi2BarTwoTone))
(def signal-wifi3-bar (interop/react-factory SignalWifi3Bar))
(def signal-wifi3-bar-lock (interop/react-factory SignalWifi3BarLock))
(def signal-wifi3-bar-lock-outlined (interop/react-factory SignalWifi3BarLockOutlined))
(def signal-wifi3-bar-lock-rounded (interop/react-factory SignalWifi3BarLockRounded))
(def signal-wifi3-bar-lock-sharp (interop/react-factory SignalWifi3BarLockSharp))
(def signal-wifi3-bar-lock-two-tone (interop/react-factory SignalWifi3BarLockTwoTone))
(def signal-wifi3-bar-outlined (interop/react-factory SignalWifi3BarOutlined))
(def signal-wifi3-bar-rounded (interop/react-factory SignalWifi3BarRounded))
(def signal-wifi3-bar-sharp (interop/react-factory SignalWifi3BarSharp))
(def signal-wifi3-bar-two-tone (interop/react-factory SignalWifi3BarTwoTone))
(def signal-wifi4-bar (interop/react-factory SignalWifi4Bar))
(def signal-wifi4-bar-lock (interop/react-factory SignalWifi4BarLock))
(def signal-wifi4-bar-lock-outlined (interop/react-factory SignalWifi4BarLockOutlined))
(def signal-wifi4-bar-lock-rounded (interop/react-factory SignalWifi4BarLockRounded))
(def signal-wifi4-bar-lock-sharp (interop/react-factory SignalWifi4BarLockSharp))
(def signal-wifi4-bar-lock-two-tone (interop/react-factory SignalWifi4BarLockTwoTone))
(def signal-wifi4-bar-outlined (interop/react-factory SignalWifi4BarOutlined))
(def signal-wifi4-bar-rounded (interop/react-factory SignalWifi4BarRounded))
(def signal-wifi4-bar-sharp (interop/react-factory SignalWifi4BarSharp))
(def signal-wifi4-bar-two-tone (interop/react-factory SignalWifi4BarTwoTone))
(def signal-wifi-off (interop/react-factory SignalWifiOff))
(def signal-wifi-off-outlined (interop/react-factory SignalWifiOffOutlined))
(def signal-wifi-off-rounded (interop/react-factory SignalWifiOffRounded))
(def signal-wifi-off-sharp (interop/react-factory SignalWifiOffSharp))
(def signal-wifi-off-two-tone (interop/react-factory SignalWifiOffTwoTone))
(def sim-card (interop/react-factory SimCard))
(def sim-card-outlined (interop/react-factory SimCardOutlined))
(def sim-card-rounded (interop/react-factory SimCardRounded))
(def sim-card-sharp (interop/react-factory SimCardSharp))
(def sim-card-two-tone (interop/react-factory SimCardTwoTone))
(def single-bed (interop/react-factory SingleBed))
(def single-bed-outlined (interop/react-factory SingleBedOutlined))
(def single-bed-rounded (interop/react-factory SingleBedRounded))
(def single-bed-sharp (interop/react-factory SingleBedSharp))
(def single-bed-two-tone (interop/react-factory SingleBedTwoTone))
(def skip-next (interop/react-factory SkipNext))
(def skip-next-outlined (interop/react-factory SkipNextOutlined))
(def skip-next-rounded (interop/react-factory SkipNextRounded))
(def skip-next-sharp (interop/react-factory SkipNextSharp))
(def skip-next-two-tone (interop/react-factory SkipNextTwoTone))
(def skip-previous (interop/react-factory SkipPrevious))
(def skip-previous-outlined (interop/react-factory SkipPreviousOutlined))
(def skip-previous-rounded (interop/react-factory SkipPreviousRounded))
(def skip-previous-sharp (interop/react-factory SkipPreviousSharp))
(def skip-previous-two-tone (interop/react-factory SkipPreviousTwoTone))
(def slideshow (interop/react-factory Slideshow))
(def slideshow-outlined (interop/react-factory SlideshowOutlined))
(def slideshow-rounded (interop/react-factory SlideshowRounded))
(def slideshow-sharp (interop/react-factory SlideshowSharp))
(def slideshow-two-tone (interop/react-factory SlideshowTwoTone))
(def slow-motion-video (interop/react-factory SlowMotionVideo))
(def slow-motion-video-outlined (interop/react-factory SlowMotionVideoOutlined))
(def slow-motion-video-rounded (interop/react-factory SlowMotionVideoRounded))
(def slow-motion-video-sharp (interop/react-factory SlowMotionVideoSharp))
(def slow-motion-video-two-tone (interop/react-factory SlowMotionVideoTwoTone))
(def smartphone (interop/react-factory Smartphone))
(def smartphone-outlined (interop/react-factory SmartphoneOutlined))
(def smartphone-rounded (interop/react-factory SmartphoneRounded))
(def smartphone-sharp (interop/react-factory SmartphoneSharp))
(def smartphone-two-tone (interop/react-factory SmartphoneTwoTone))
(def smoke-free (interop/react-factory SmokeFree))
(def smoke-free-outlined (interop/react-factory SmokeFreeOutlined))
(def smoke-free-rounded (interop/react-factory SmokeFreeRounded))
(def smoke-free-sharp (interop/react-factory SmokeFreeSharp))
(def smoke-free-two-tone (interop/react-factory SmokeFreeTwoTone))
(def smoking-rooms (interop/react-factory SmokingRooms))
(def smoking-rooms-outlined (interop/react-factory SmokingRoomsOutlined))
(def smoking-rooms-rounded (interop/react-factory SmokingRoomsRounded))
(def smoking-rooms-sharp (interop/react-factory SmokingRoomsSharp))
(def smoking-rooms-two-tone (interop/react-factory SmokingRoomsTwoTone))
(def sms (interop/react-factory Sms))
(def sms-failed (interop/react-factory SmsFailed))
(def sms-failed-outlined (interop/react-factory SmsFailedOutlined))
(def sms-failed-rounded (interop/react-factory SmsFailedRounded))
(def sms-failed-sharp (interop/react-factory SmsFailedSharp))
(def sms-failed-two-tone (interop/react-factory SmsFailedTwoTone))
(def sms-outlined (interop/react-factory SmsOutlined))
(def sms-rounded (interop/react-factory SmsRounded))
(def sms-sharp (interop/react-factory SmsSharp))
(def sms-two-tone (interop/react-factory SmsTwoTone))
(def snooze (interop/react-factory Snooze))
(def snooze-outlined (interop/react-factory SnoozeOutlined))
(def snooze-rounded (interop/react-factory SnoozeRounded))
(def snooze-sharp (interop/react-factory SnoozeSharp))
(def snooze-two-tone (interop/react-factory SnoozeTwoTone))
(def sort (interop/react-factory Sort))
(def sort-by-alpha (interop/react-factory SortByAlpha))
(def sort-by-alpha-outlined (interop/react-factory SortByAlphaOutlined))
(def sort-by-alpha-rounded (interop/react-factory SortByAlphaRounded))
(def sort-by-alpha-sharp (interop/react-factory SortByAlphaSharp))
(def sort-by-alpha-two-tone (interop/react-factory SortByAlphaTwoTone))
(def sort-outlined (interop/react-factory SortOutlined))
(def sort-rounded (interop/react-factory SortRounded))
(def sort-sharp (interop/react-factory SortSharp))
(def sort-two-tone (interop/react-factory SortTwoTone))
(def spa (interop/react-factory Spa))
(def space-bar (interop/react-factory SpaceBar))
(def space-bar-outlined (interop/react-factory SpaceBarOutlined))
(def space-bar-rounded (interop/react-factory SpaceBarRounded))
(def space-bar-sharp (interop/react-factory SpaceBarSharp))
(def space-bar-two-tone (interop/react-factory SpaceBarTwoTone))
(def spa-outlined (interop/react-factory SpaOutlined))
(def spa-rounded (interop/react-factory SpaRounded))
(def spa-sharp (interop/react-factory SpaSharp))
(def spa-two-tone (interop/react-factory SpaTwoTone))
(def speaker (interop/react-factory Speaker))
(def speaker-group (interop/react-factory SpeakerGroup))
(def speaker-group-outlined (interop/react-factory SpeakerGroupOutlined))
(def speaker-group-rounded (interop/react-factory SpeakerGroupRounded))
(def speaker-group-sharp (interop/react-factory SpeakerGroupSharp))
(def speaker-group-two-tone (interop/react-factory SpeakerGroupTwoTone))
(def speaker-notes (interop/react-factory SpeakerNotes))
(def speaker-notes-off (interop/react-factory SpeakerNotesOff))
(def speaker-notes-off-outlined (interop/react-factory SpeakerNotesOffOutlined))
(def speaker-notes-off-rounded (interop/react-factory SpeakerNotesOffRounded))
(def speaker-notes-off-sharp (interop/react-factory SpeakerNotesOffSharp))
(def speaker-notes-off-two-tone (interop/react-factory SpeakerNotesOffTwoTone))
(def speaker-notes-outlined (interop/react-factory SpeakerNotesOutlined))
(def speaker-notes-rounded (interop/react-factory SpeakerNotesRounded))
(def speaker-notes-sharp (interop/react-factory SpeakerNotesSharp))
(def speaker-notes-two-tone (interop/react-factory SpeakerNotesTwoTone))
(def speaker-outlined (interop/react-factory SpeakerOutlined))
(def speaker-phone (interop/react-factory SpeakerPhone))
(def speaker-phone-outlined (interop/react-factory SpeakerPhoneOutlined))
(def speaker-phone-rounded (interop/react-factory SpeakerPhoneRounded))
(def speaker-phone-sharp (interop/react-factory SpeakerPhoneSharp))
(def speaker-phone-two-tone (interop/react-factory SpeakerPhoneTwoTone))
(def speaker-rounded (interop/react-factory SpeakerRounded))
(def speaker-sharp (interop/react-factory SpeakerSharp))
(def speaker-two-tone (interop/react-factory SpeakerTwoTone))
(def speed (interop/react-factory Speed))
(def speed-outlined (interop/react-factory SpeedOutlined))
(def speed-rounded (interop/react-factory SpeedRounded))
(def speed-sharp (interop/react-factory SpeedSharp))
(def speed-two-tone (interop/react-factory SpeedTwoTone))
(def spellcheck (interop/react-factory Spellcheck))
(def spellcheck-outlined (interop/react-factory SpellcheckOutlined))
(def spellcheck-rounded (interop/react-factory SpellcheckRounded))
(def spellcheck-sharp (interop/react-factory SpellcheckSharp))
(def spellcheck-two-tone (interop/react-factory SpellcheckTwoTone))
(def sports (interop/react-factory Sports))
(def sports-baseball (interop/react-factory SportsBaseball))
(def sports-baseball-outlined (interop/react-factory SportsBaseballOutlined))
(def sports-baseball-rounded (interop/react-factory SportsBaseballRounded))
(def sports-baseball-sharp (interop/react-factory SportsBaseballSharp))
(def sports-baseball-two-tone (interop/react-factory SportsBaseballTwoTone))
(def sports-basketball (interop/react-factory SportsBasketball))
(def sports-basketball-outlined (interop/react-factory SportsBasketballOutlined))
(def sports-basketball-rounded (interop/react-factory SportsBasketballRounded))
(def sports-basketball-sharp (interop/react-factory SportsBasketballSharp))
(def sports-basketball-two-tone (interop/react-factory SportsBasketballTwoTone))
(def sports-cricket (interop/react-factory SportsCricket))
(def sports-cricket-outlined (interop/react-factory SportsCricketOutlined))
(def sports-cricket-rounded (interop/react-factory SportsCricketRounded))
(def sports-cricket-sharp (interop/react-factory SportsCricketSharp))
(def sports-cricket-two-tone (interop/react-factory SportsCricketTwoTone))
(def sports-esports (interop/react-factory SportsEsports))
(def sports-esports-outlined (interop/react-factory SportsEsportsOutlined))
(def sports-esports-rounded (interop/react-factory SportsEsportsRounded))
(def sports-esports-sharp (interop/react-factory SportsEsportsSharp))
(def sports-esports-two-tone (interop/react-factory SportsEsportsTwoTone))
(def sports-football (interop/react-factory SportsFootball))
(def sports-football-outlined (interop/react-factory SportsFootballOutlined))
(def sports-football-rounded (interop/react-factory SportsFootballRounded))
(def sports-football-sharp (interop/react-factory SportsFootballSharp))
(def sports-football-two-tone (interop/react-factory SportsFootballTwoTone))
(def sports-golf (interop/react-factory SportsGolf))
(def sports-golf-outlined (interop/react-factory SportsGolfOutlined))
(def sports-golf-rounded (interop/react-factory SportsGolfRounded))
(def sports-golf-sharp (interop/react-factory SportsGolfSharp))
(def sports-golf-two-tone (interop/react-factory SportsGolfTwoTone))
(def sports-handball (interop/react-factory SportsHandball))
(def sports-handball-outlined (interop/react-factory SportsHandballOutlined))
(def sports-handball-rounded (interop/react-factory SportsHandballRounded))
(def sports-handball-sharp (interop/react-factory SportsHandballSharp))
(def sports-handball-two-tone (interop/react-factory SportsHandballTwoTone))
(def sports-hockey (interop/react-factory SportsHockey))
(def sports-hockey-outlined (interop/react-factory SportsHockeyOutlined))
(def sports-hockey-rounded (interop/react-factory SportsHockeyRounded))
(def sports-hockey-sharp (interop/react-factory SportsHockeySharp))
(def sports-hockey-two-tone (interop/react-factory SportsHockeyTwoTone))
(def sports-kabaddi (interop/react-factory SportsKabaddi))
(def sports-kabaddi-outlined (interop/react-factory SportsKabaddiOutlined))
(def sports-kabaddi-rounded (interop/react-factory SportsKabaddiRounded))
(def sports-kabaddi-sharp (interop/react-factory SportsKabaddiSharp))
(def sports-kabaddi-two-tone (interop/react-factory SportsKabaddiTwoTone))
(def sports-mma (interop/react-factory SportsMma))
(def sports-mma-outlined (interop/react-factory SportsMmaOutlined))
(def sports-mma-rounded (interop/react-factory SportsMmaRounded))
(def sports-mma-sharp (interop/react-factory SportsMmaSharp))
(def sports-mma-two-tone (interop/react-factory SportsMmaTwoTone))
(def sports-motorsports (interop/react-factory SportsMotorsports))
(def sports-motorsports-outlined (interop/react-factory SportsMotorsportsOutlined))
(def sports-motorsports-rounded (interop/react-factory SportsMotorsportsRounded))
(def sports-motorsports-sharp (interop/react-factory SportsMotorsportsSharp))
(def sports-motorsports-two-tone (interop/react-factory SportsMotorsportsTwoTone))
(def sports-outlined (interop/react-factory SportsOutlined))
(def sports-rounded (interop/react-factory SportsRounded))
(def sports-rugby (interop/react-factory SportsRugby))
(def sports-rugby-outlined (interop/react-factory SportsRugbyOutlined))
(def sports-rugby-rounded (interop/react-factory SportsRugbyRounded))
(def sports-rugby-sharp (interop/react-factory SportsRugbySharp))
(def sports-rugby-two-tone (interop/react-factory SportsRugbyTwoTone))
(def sports-sharp (interop/react-factory SportsSharp))
(def sports-soccer (interop/react-factory SportsSoccer))
(def sports-soccer-outlined (interop/react-factory SportsSoccerOutlined))
(def sports-soccer-rounded (interop/react-factory SportsSoccerRounded))
(def sports-soccer-sharp (interop/react-factory SportsSoccerSharp))
(def sports-soccer-two-tone (interop/react-factory SportsSoccerTwoTone))
(def sports-tennis (interop/react-factory SportsTennis))
(def sports-tennis-outlined (interop/react-factory SportsTennisOutlined))
(def sports-tennis-rounded (interop/react-factory SportsTennisRounded))
(def sports-tennis-sharp (interop/react-factory SportsTennisSharp))
(def sports-tennis-two-tone (interop/react-factory SportsTennisTwoTone))
(def sports-two-tone (interop/react-factory SportsTwoTone))
(def sports-volleyball (interop/react-factory SportsVolleyball))
(def sports-volleyball-outlined (interop/react-factory SportsVolleyballOutlined))
(def sports-volleyball-rounded (interop/react-factory SportsVolleyballRounded))
(def sports-volleyball-sharp (interop/react-factory SportsVolleyballSharp))
(def sports-volleyball-two-tone (interop/react-factory SportsVolleyballTwoTone))
(def square-foot (interop/react-factory SquareFoot))
(def square-foot-outlined (interop/react-factory SquareFootOutlined))
(def square-foot-rounded (interop/react-factory SquareFootRounded))
(def square-foot-sharp (interop/react-factory SquareFootSharp))
(def square-foot-two-tone (interop/react-factory SquareFootTwoTone))
(def star (interop/react-factory Star))
(def star-border (interop/react-factory StarBorder))
(def star-border-outlined (interop/react-factory StarBorderOutlined))
(def star-border-rounded (interop/react-factory StarBorderRounded))
(def star-border-sharp (interop/react-factory StarBorderSharp))
(def star-border-two-tone (interop/react-factory StarBorderTwoTone))
(def star-half (interop/react-factory StarHalf))
(def star-half-outlined (interop/react-factory StarHalfOutlined))
(def star-half-rounded (interop/react-factory StarHalfRounded))
(def star-half-sharp (interop/react-factory StarHalfSharp))
(def star-half-two-tone (interop/react-factory StarHalfTwoTone))
(def star-rate (interop/react-factory StarRate))
(def star-rate-outlined (interop/react-factory StarRateOutlined))
(def star-rate-rounded (interop/react-factory StarRateRounded))
(def star-rate-sharp (interop/react-factory StarRateSharp))
(def star-rate-two-tone (interop/react-factory StarRateTwoTone))
(def star-rounded (interop/react-factory StarRounded))
(def stars (interop/react-factory Stars))
(def star-sharp (interop/react-factory StarSharp))
(def stars-outlined (interop/react-factory StarsOutlined))
(def stars-rounded (interop/react-factory StarsRounded))
(def stars-sharp (interop/react-factory StarsSharp))
(def stars-two-tone (interop/react-factory StarsTwoTone))
(def star-two-tone (interop/react-factory StarTwoTone))
(def stay-current-landscape (interop/react-factory StayCurrentLandscape))
(def stay-current-landscape-outlined (interop/react-factory StayCurrentLandscapeOutlined))
(def stay-current-landscape-rounded (interop/react-factory StayCurrentLandscapeRounded))
(def stay-current-landscape-sharp (interop/react-factory StayCurrentLandscapeSharp))
(def stay-current-landscape-two-tone (interop/react-factory StayCurrentLandscapeTwoTone))
(def stay-current-portrait (interop/react-factory StayCurrentPortrait))
(def stay-current-portrait-outlined (interop/react-factory StayCurrentPortraitOutlined))
(def stay-current-portrait-rounded (interop/react-factory StayCurrentPortraitRounded))
(def stay-current-portrait-sharp (interop/react-factory StayCurrentPortraitSharp))
(def stay-current-portrait-two-tone (interop/react-factory StayCurrentPortraitTwoTone))
(def stay-primary-landscape (interop/react-factory StayPrimaryLandscape))
(def stay-primary-landscape-outlined (interop/react-factory StayPrimaryLandscapeOutlined))
(def stay-primary-landscape-rounded (interop/react-factory StayPrimaryLandscapeRounded))
(def stay-primary-landscape-sharp (interop/react-factory StayPrimaryLandscapeSharp))
(def stay-primary-landscape-two-tone (interop/react-factory StayPrimaryLandscapeTwoTone))
(def stay-primary-portrait (interop/react-factory StayPrimaryPortrait))
(def stay-primary-portrait-outlined (interop/react-factory StayPrimaryPortraitOutlined))
(def stay-primary-portrait-rounded (interop/react-factory StayPrimaryPortraitRounded))
(def stay-primary-portrait-sharp (interop/react-factory StayPrimaryPortraitSharp))
(def stay-primary-portrait-two-tone (interop/react-factory StayPrimaryPortraitTwoTone))
(def stop (interop/react-factory Stop))
(def stop-outlined (interop/react-factory StopOutlined))
(def stop-rounded (interop/react-factory StopRounded))
(def stop-screen-share (interop/react-factory StopScreenShare))
(def stop-screen-share-outlined (interop/react-factory StopScreenShareOutlined))
(def stop-screen-share-rounded (interop/react-factory StopScreenShareRounded))
(def stop-screen-share-sharp (interop/react-factory StopScreenShareSharp))
(def stop-screen-share-two-tone (interop/react-factory StopScreenShareTwoTone))
(def stop-sharp (interop/react-factory StopSharp))
(def stop-two-tone (interop/react-factory StopTwoTone))
(def storage (interop/react-factory Storage))
(def storage-outlined (interop/react-factory StorageOutlined))
(def storage-rounded (interop/react-factory StorageRounded))
(def storage-sharp (interop/react-factory StorageSharp))
(def storage-two-tone (interop/react-factory StorageTwoTone))
(def store (interop/react-factory Store))
(def storefront (interop/react-factory Storefront))
(def storefront-outlined (interop/react-factory StorefrontOutlined))
(def storefront-rounded (interop/react-factory StorefrontRounded))
(def storefront-sharp (interop/react-factory StorefrontSharp))
(def storefront-two-tone (interop/react-factory StorefrontTwoTone))
(def store-mall-directory (interop/react-factory StoreMallDirectory))
(def store-mall-directory-outlined (interop/react-factory StoreMallDirectoryOutlined))
(def store-mall-directory-rounded (interop/react-factory StoreMallDirectoryRounded))
(def store-mall-directory-sharp (interop/react-factory StoreMallDirectorySharp))
(def store-mall-directory-two-tone (interop/react-factory StoreMallDirectoryTwoTone))
(def store-outlined (interop/react-factory StoreOutlined))
(def store-rounded (interop/react-factory StoreRounded))
(def store-sharp (interop/react-factory StoreSharp))
(def store-two-tone (interop/react-factory StoreTwoTone))
(def straighten (interop/react-factory Straighten))
(def straighten-outlined (interop/react-factory StraightenOutlined))
(def straighten-rounded (interop/react-factory StraightenRounded))
(def straighten-sharp (interop/react-factory StraightenSharp))
(def straighten-two-tone (interop/react-factory StraightenTwoTone))
(def streetview (interop/react-factory Streetview))
(def streetview-outlined (interop/react-factory StreetviewOutlined))
(def streetview-rounded (interop/react-factory StreetviewRounded))
(def streetview-sharp (interop/react-factory StreetviewSharp))
(def streetview-two-tone (interop/react-factory StreetviewTwoTone))
(def strikethrough-s (interop/react-factory StrikethroughS))
(def strikethrough-s-outlined (interop/react-factory StrikethroughSOutlined))
(def strikethrough-s-rounded (interop/react-factory StrikethroughSRounded))
(def strikethrough-s-sharp (interop/react-factory StrikethroughSSharp))
(def strikethrough-s-two-tone (interop/react-factory StrikethroughSTwoTone))
(def style (interop/react-factory Style))
(def style-outlined (interop/react-factory StyleOutlined))
(def style-rounded (interop/react-factory StyleRounded))
(def style-sharp (interop/react-factory StyleSharp))
(def style-two-tone (interop/react-factory StyleTwoTone))
(def subdirectory-arrow-left (interop/react-factory SubdirectoryArrowLeft))
(def subdirectory-arrow-left-outlined (interop/react-factory SubdirectoryArrowLeftOutlined))
(def subdirectory-arrow-left-rounded (interop/react-factory SubdirectoryArrowLeftRounded))
(def subdirectory-arrow-left-sharp (interop/react-factory SubdirectoryArrowLeftSharp))
(def subdirectory-arrow-left-two-tone (interop/react-factory SubdirectoryArrowLeftTwoTone))
(def subdirectory-arrow-right (interop/react-factory SubdirectoryArrowRight))
(def subdirectory-arrow-right-outlined (interop/react-factory SubdirectoryArrowRightOutlined))
(def subdirectory-arrow-right-rounded (interop/react-factory SubdirectoryArrowRightRounded))
(def subdirectory-arrow-right-sharp (interop/react-factory SubdirectoryArrowRightSharp))
(def subdirectory-arrow-right-two-tone (interop/react-factory SubdirectoryArrowRightTwoTone))
(def subject (interop/react-factory Subject))
(def subject-outlined (interop/react-factory SubjectOutlined))
(def subject-rounded (interop/react-factory SubjectRounded))
(def subject-sharp (interop/react-factory SubjectSharp))
(def subject-two-tone (interop/react-factory SubjectTwoTone))
(def subscriptions (interop/react-factory Subscriptions))
(def subscriptions-outlined (interop/react-factory SubscriptionsOutlined))
(def subscriptions-rounded (interop/react-factory SubscriptionsRounded))
(def subscriptions-sharp (interop/react-factory SubscriptionsSharp))
(def subscriptions-two-tone (interop/react-factory SubscriptionsTwoTone))
(def subtitles (interop/react-factory Subtitles))
(def subtitles-outlined (interop/react-factory SubtitlesOutlined))
(def subtitles-rounded (interop/react-factory SubtitlesRounded))
(def subtitles-sharp (interop/react-factory SubtitlesSharp))
(def subtitles-two-tone (interop/react-factory SubtitlesTwoTone))
(def subway (interop/react-factory Subway))
(def subway-outlined (interop/react-factory SubwayOutlined))
(def subway-rounded (interop/react-factory SubwayRounded))
(def subway-sharp (interop/react-factory SubwaySharp))
(def subway-two-tone (interop/react-factory SubwayTwoTone))
(def supervised-user-circle (interop/react-factory SupervisedUserCircle))
(def supervised-user-circle-outlined (interop/react-factory SupervisedUserCircleOutlined))
(def supervised-user-circle-rounded (interop/react-factory SupervisedUserCircleRounded))
(def supervised-user-circle-sharp (interop/react-factory SupervisedUserCircleSharp))
(def supervised-user-circle-two-tone (interop/react-factory SupervisedUserCircleTwoTone))
(def supervisor-account (interop/react-factory SupervisorAccount))
(def supervisor-account-outlined (interop/react-factory SupervisorAccountOutlined))
(def supervisor-account-rounded (interop/react-factory SupervisorAccountRounded))
(def supervisor-account-sharp (interop/react-factory SupervisorAccountSharp))
(def supervisor-account-two-tone (interop/react-factory SupervisorAccountTwoTone))
(def surround-sound (interop/react-factory SurroundSound))
(def surround-sound-outlined (interop/react-factory SurroundSoundOutlined))
(def surround-sound-rounded (interop/react-factory SurroundSoundRounded))
(def surround-sound-sharp (interop/react-factory SurroundSoundSharp))
(def surround-sound-two-tone (interop/react-factory SurroundSoundTwoTone))
(def swap-calls (interop/react-factory SwapCalls))
(def swap-calls-outlined (interop/react-factory SwapCallsOutlined))
(def swap-calls-rounded (interop/react-factory SwapCallsRounded))
(def swap-calls-sharp (interop/react-factory SwapCallsSharp))
(def swap-calls-two-tone (interop/react-factory SwapCallsTwoTone))
(def swap-horiz (interop/react-factory SwapHoriz))
(def swap-horizontal-circle (interop/react-factory SwapHorizontalCircle))
(def swap-horizontal-circle-outlined (interop/react-factory SwapHorizontalCircleOutlined))
(def swap-horizontal-circle-rounded (interop/react-factory SwapHorizontalCircleRounded))
(def swap-horizontal-circle-sharp (interop/react-factory SwapHorizontalCircleSharp))
(def swap-horizontal-circle-two-tone (interop/react-factory SwapHorizontalCircleTwoTone))
(def swap-horiz-outlined (interop/react-factory SwapHorizOutlined))
(def swap-horiz-rounded (interop/react-factory SwapHorizRounded))
(def swap-horiz-sharp (interop/react-factory SwapHorizSharp))
(def swap-horiz-two-tone (interop/react-factory SwapHorizTwoTone))
(def swap-vert (interop/react-factory SwapVert))
(def swap-vertical-circle (interop/react-factory SwapVerticalCircle))
(def swap-vertical-circle-outlined (interop/react-factory SwapVerticalCircleOutlined))
(def swap-vertical-circle-rounded (interop/react-factory SwapVerticalCircleRounded))
(def swap-vertical-circle-sharp (interop/react-factory SwapVerticalCircleSharp))
(def swap-vertical-circle-two-tone (interop/react-factory SwapVerticalCircleTwoTone))
(def swap-vert-outlined (interop/react-factory SwapVertOutlined))
(def swap-vert-rounded (interop/react-factory SwapVertRounded))
(def swap-vert-sharp (interop/react-factory SwapVertSharp))
(def swap-vert-two-tone (interop/react-factory SwapVertTwoTone))
(def switch-camera (interop/react-factory SwitchCamera))
(def switch-camera-outlined (interop/react-factory SwitchCameraOutlined))
(def switch-camera-rounded (interop/react-factory SwitchCameraRounded))
(def switch-camera-sharp (interop/react-factory SwitchCameraSharp))
(def switch-camera-two-tone (interop/react-factory SwitchCameraTwoTone))
(def switch-video (interop/react-factory SwitchVideo))
(def switch-video-outlined (interop/react-factory SwitchVideoOutlined))
(def switch-video-rounded (interop/react-factory SwitchVideoRounded))
(def switch-video-sharp (interop/react-factory SwitchVideoSharp))
(def switch-video-two-tone (interop/react-factory SwitchVideoTwoTone))
(def sync (interop/react-factory Sync))
(def sync-alt (interop/react-factory SyncAlt))
(def sync-alt-outlined (interop/react-factory SyncAltOutlined))
(def sync-alt-rounded (interop/react-factory SyncAltRounded))
(def sync-alt-sharp (interop/react-factory SyncAltSharp))
(def sync-alt-two-tone (interop/react-factory SyncAltTwoTone))
(def sync-disabled (interop/react-factory SyncDisabled))
(def sync-disabled-outlined (interop/react-factory SyncDisabledOutlined))
(def sync-disabled-rounded (interop/react-factory SyncDisabledRounded))
(def sync-disabled-sharp (interop/react-factory SyncDisabledSharp))
(def sync-disabled-two-tone (interop/react-factory SyncDisabledTwoTone))
(def sync-outlined (interop/react-factory SyncOutlined))
(def sync-problem (interop/react-factory SyncProblem))
(def sync-problem-outlined (interop/react-factory SyncProblemOutlined))
(def sync-problem-rounded (interop/react-factory SyncProblemRounded))
(def sync-problem-sharp (interop/react-factory SyncProblemSharp))
(def sync-problem-two-tone (interop/react-factory SyncProblemTwoTone))
(def sync-rounded (interop/react-factory SyncRounded))
(def sync-sharp (interop/react-factory SyncSharp))
(def sync-two-tone (interop/react-factory SyncTwoTone))
(def system-update (interop/react-factory SystemUpdate))
(def system-update-alt (interop/react-factory SystemUpdateAlt))
(def system-update-alt-outlined (interop/react-factory SystemUpdateAltOutlined))
(def system-update-alt-rounded (interop/react-factory SystemUpdateAltRounded))
(def system-update-alt-sharp (interop/react-factory SystemUpdateAltSharp))
(def system-update-alt-two-tone (interop/react-factory SystemUpdateAltTwoTone))
(def system-update-outlined (interop/react-factory SystemUpdateOutlined))
(def system-update-rounded (interop/react-factory SystemUpdateRounded))
(def system-update-sharp (interop/react-factory SystemUpdateSharp))
(def system-update-two-tone (interop/react-factory SystemUpdateTwoTone))
(def tab (interop/react-factory Tab))
(def table-chart (interop/react-factory TableChart))
(def table-chart-outlined (interop/react-factory TableChartOutlined))
(def table-chart-rounded (interop/react-factory TableChartRounded))
(def table-chart-sharp (interop/react-factory TableChartSharp))
(def table-chart-two-tone (interop/react-factory TableChartTwoTone))
(def tablet (interop/react-factory Tablet))
(def tablet-android (interop/react-factory TabletAndroid))
(def tablet-android-outlined (interop/react-factory TabletAndroidOutlined))
(def tablet-android-rounded (interop/react-factory TabletAndroidRounded))
(def tablet-android-sharp (interop/react-factory TabletAndroidSharp))
(def tablet-android-two-tone (interop/react-factory TabletAndroidTwoTone))
(def tablet-mac (interop/react-factory TabletMac))
(def tablet-mac-outlined (interop/react-factory TabletMacOutlined))
(def tablet-mac-rounded (interop/react-factory TabletMacRounded))
(def tablet-mac-sharp (interop/react-factory TabletMacSharp))
(def tablet-mac-two-tone (interop/react-factory TabletMacTwoTone))
(def tablet-outlined (interop/react-factory TabletOutlined))
(def tablet-rounded (interop/react-factory TabletRounded))
(def tablet-sharp (interop/react-factory TabletSharp))
(def tablet-two-tone (interop/react-factory TabletTwoTone))
(def tab-outlined (interop/react-factory TabOutlined))
(def tab-rounded (interop/react-factory TabRounded))
(def tab-sharp (interop/react-factory TabSharp))
(def tab-two-tone (interop/react-factory TabTwoTone))
(def tab-unselected (interop/react-factory TabUnselected))
(def tab-unselected-outlined (interop/react-factory TabUnselectedOutlined))
(def tab-unselected-rounded (interop/react-factory TabUnselectedRounded))
(def tab-unselected-sharp (interop/react-factory TabUnselectedSharp))
(def tab-unselected-two-tone (interop/react-factory TabUnselectedTwoTone))
(def tag-faces (interop/react-factory TagFaces))
(def tag-faces-outlined (interop/react-factory TagFacesOutlined))
(def tag-faces-rounded (interop/react-factory TagFacesRounded))
(def tag-faces-sharp (interop/react-factory TagFacesSharp))
(def tag-faces-two-tone (interop/react-factory TagFacesTwoTone))
(def tap-and-play (interop/react-factory TapAndPlay))
(def tap-and-play-outlined (interop/react-factory TapAndPlayOutlined))
(def tap-and-play-rounded (interop/react-factory TapAndPlayRounded))
(def tap-and-play-sharp (interop/react-factory TapAndPlaySharp))
(def tap-and-play-two-tone (interop/react-factory TapAndPlayTwoTone))
(def telegram (interop/react-factory Telegram))
(def terrain (interop/react-factory Terrain))
(def terrain-outlined (interop/react-factory TerrainOutlined))
(def terrain-rounded (interop/react-factory TerrainRounded))
(def terrain-sharp (interop/react-factory TerrainSharp))
(def terrain-two-tone (interop/react-factory TerrainTwoTone))
(def text-fields (interop/react-factory TextFields))
(def text-fields-outlined (interop/react-factory TextFieldsOutlined))
(def text-fields-rounded (interop/react-factory TextFieldsRounded))
(def text-fields-sharp (interop/react-factory TextFieldsSharp))
(def text-fields-two-tone (interop/react-factory TextFieldsTwoTone))
(def text-format (interop/react-factory TextFormat))
(def text-format-outlined (interop/react-factory TextFormatOutlined))
(def text-format-rounded (interop/react-factory TextFormatRounded))
(def text-format-sharp (interop/react-factory TextFormatSharp))
(def text-format-two-tone (interop/react-factory TextFormatTwoTone))
(def text-rotate-up (interop/react-factory TextRotateUp))
(def text-rotate-up-outlined (interop/react-factory TextRotateUpOutlined))
(def text-rotate-up-rounded (interop/react-factory TextRotateUpRounded))
(def text-rotate-up-sharp (interop/react-factory TextRotateUpSharp))
(def text-rotate-up-two-tone (interop/react-factory TextRotateUpTwoTone))
(def text-rotate-vertical (interop/react-factory TextRotateVertical))
(def text-rotate-vertical-outlined (interop/react-factory TextRotateVerticalOutlined))
(def text-rotate-vertical-rounded (interop/react-factory TextRotateVerticalRounded))
(def text-rotate-vertical-sharp (interop/react-factory TextRotateVerticalSharp))
(def text-rotate-vertical-two-tone (interop/react-factory TextRotateVerticalTwoTone))
(def text-rotation-angledown (interop/react-factory TextRotationAngledown))
(def text-rotation-angledown-outlined (interop/react-factory TextRotationAngledownOutlined))
(def text-rotation-angledown-rounded (interop/react-factory TextRotationAngledownRounded))
(def text-rotation-angledown-sharp (interop/react-factory TextRotationAngledownSharp))
(def text-rotation-angledown-two-tone (interop/react-factory TextRotationAngledownTwoTone))
(def text-rotation-angleup (interop/react-factory TextRotationAngleup))
(def text-rotation-angleup-outlined (interop/react-factory TextRotationAngleupOutlined))
(def text-rotation-angleup-rounded (interop/react-factory TextRotationAngleupRounded))
(def text-rotation-angleup-sharp (interop/react-factory TextRotationAngleupSharp))
(def text-rotation-angleup-two-tone (interop/react-factory TextRotationAngleupTwoTone))
(def text-rotation-down (interop/react-factory TextRotationDown))
(def text-rotation-down-outlined (interop/react-factory TextRotationDownOutlined))
(def text-rotation-down-rounded (interop/react-factory TextRotationDownRounded))
(def text-rotation-down-sharp (interop/react-factory TextRotationDownSharp))
(def text-rotation-down-two-tone (interop/react-factory TextRotationDownTwoTone))
(def text-rotation-none (interop/react-factory TextRotationNone))
(def text-rotation-none-outlined (interop/react-factory TextRotationNoneOutlined))
(def text-rotation-none-rounded (interop/react-factory TextRotationNoneRounded))
(def text-rotation-none-sharp (interop/react-factory TextRotationNoneSharp))
(def text-rotation-none-two-tone (interop/react-factory TextRotationNoneTwoTone))
(def textsms (interop/react-factory Textsms))
(def textsms-outlined (interop/react-factory TextsmsOutlined))
(def textsms-rounded (interop/react-factory TextsmsRounded))
(def textsms-sharp (interop/react-factory TextsmsSharp))
(def textsms-two-tone (interop/react-factory TextsmsTwoTone))
(def texture (interop/react-factory Texture))
(def texture-outlined (interop/react-factory TextureOutlined))
(def texture-rounded (interop/react-factory TextureRounded))
(def texture-sharp (interop/react-factory TextureSharp))
(def texture-two-tone (interop/react-factory TextureTwoTone))
(def theaters (interop/react-factory Theaters))
(def theaters-outlined (interop/react-factory TheatersOutlined))
(def theaters-rounded (interop/react-factory TheatersRounded))
(def theaters-sharp (interop/react-factory TheatersSharp))
(def theaters-two-tone (interop/react-factory TheatersTwoTone))
(def three-d-rotation (interop/react-factory ThreeDRotation))
(def three-d-rotation-outlined (interop/react-factory ThreeDRotationOutlined))
(def three-d-rotation-rounded (interop/react-factory ThreeDRotationRounded))
(def three-d-rotation-sharp (interop/react-factory ThreeDRotationSharp))
(def three-d-rotation-two-tone (interop/react-factory ThreeDRotationTwoTone))
(def three-sixty (interop/react-factory ThreeSixty))
(def three-sixty-outlined (interop/react-factory ThreeSixtyOutlined))
(def three-sixty-rounded (interop/react-factory ThreeSixtyRounded))
(def three-sixty-sharp (interop/react-factory ThreeSixtySharp))
(def three-sixty-two-tone (interop/react-factory ThreeSixtyTwoTone))
(def thumb-down (interop/react-factory ThumbDown))
(def thumb-down-alt (interop/react-factory ThumbDownAlt))
(def thumb-down-alt-outlined (interop/react-factory ThumbDownAltOutlined))
(def thumb-down-alt-rounded (interop/react-factory ThumbDownAltRounded))
(def thumb-down-alt-sharp (interop/react-factory ThumbDownAltSharp))
(def thumb-down-alt-two-tone (interop/react-factory ThumbDownAltTwoTone))
(def thumb-down-outlined (interop/react-factory ThumbDownOutlined))
(def thumb-down-rounded (interop/react-factory ThumbDownRounded))
(def thumb-down-sharp (interop/react-factory ThumbDownSharp))
(def thumb-down-two-tone (interop/react-factory ThumbDownTwoTone))
(def thumbs-up-down (interop/react-factory ThumbsUpDown))
(def thumbs-up-down-outlined (interop/react-factory ThumbsUpDownOutlined))
(def thumbs-up-down-rounded (interop/react-factory ThumbsUpDownRounded))
(def thumbs-up-down-sharp (interop/react-factory ThumbsUpDownSharp))
(def thumbs-up-down-two-tone (interop/react-factory ThumbsUpDownTwoTone))
(def thumb-up (interop/react-factory ThumbUp))
(def thumb-up-alt (interop/react-factory ThumbUpAlt))
(def thumb-up-alt-outlined (interop/react-factory ThumbUpAltOutlined))
(def thumb-up-alt-rounded (interop/react-factory ThumbUpAltRounded))
(def thumb-up-alt-sharp (interop/react-factory ThumbUpAltSharp))
(def thumb-up-alt-two-tone (interop/react-factory ThumbUpAltTwoTone))
(def thumb-up-outlined (interop/react-factory ThumbUpOutlined))
(def thumb-up-rounded (interop/react-factory ThumbUpRounded))
(def thumb-up-sharp (interop/react-factory ThumbUpSharp))
(def thumb-up-two-tone (interop/react-factory ThumbUpTwoTone))
(def timelapse (interop/react-factory Timelapse))
(def timelapse-outlined (interop/react-factory TimelapseOutlined))
(def timelapse-rounded (interop/react-factory TimelapseRounded))
(def timelapse-sharp (interop/react-factory TimelapseSharp))
(def timelapse-two-tone (interop/react-factory TimelapseTwoTone))
(def timeline (interop/react-factory Timeline))
(def timeline-outlined (interop/react-factory TimelineOutlined))
(def timeline-rounded (interop/react-factory TimelineRounded))
(def timeline-sharp (interop/react-factory TimelineSharp))
(def timeline-two-tone (interop/react-factory TimelineTwoTone))
(def timer (interop/react-factory Timer))
(def timer10 (interop/react-factory Timer10))
(def timer10-outlined (interop/react-factory Timer10Outlined))
(def timer10-rounded (interop/react-factory Timer10Rounded))
(def timer10-sharp (interop/react-factory Timer10Sharp))
(def timer10-two-tone (interop/react-factory Timer10TwoTone))
(def timer3 (interop/react-factory Timer3))
(def timer3-outlined (interop/react-factory Timer3Outlined))
(def timer3-rounded (interop/react-factory Timer3Rounded))
(def timer3-sharp (interop/react-factory Timer3Sharp))
(def timer3-two-tone (interop/react-factory Timer3TwoTone))
(def timer-off (interop/react-factory TimerOff))
(def timer-off-outlined (interop/react-factory TimerOffOutlined))
(def timer-off-rounded (interop/react-factory TimerOffRounded))
(def timer-off-sharp (interop/react-factory TimerOffSharp))
(def timer-off-two-tone (interop/react-factory TimerOffTwoTone))
(def timer-outlined (interop/react-factory TimerOutlined))
(def timer-rounded (interop/react-factory TimerRounded))
(def timer-sharp (interop/react-factory TimerSharp))
(def timer-two-tone (interop/react-factory TimerTwoTone))
(def time-to-leave (interop/react-factory TimeToLeave))
(def time-to-leave-outlined (interop/react-factory TimeToLeaveOutlined))
(def time-to-leave-rounded (interop/react-factory TimeToLeaveRounded))
(def time-to-leave-sharp (interop/react-factory TimeToLeaveSharp))
(def time-to-leave-two-tone (interop/react-factory TimeToLeaveTwoTone))
(def title (interop/react-factory Title))
(def title-outlined (interop/react-factory TitleOutlined))
(def title-rounded (interop/react-factory TitleRounded))
(def title-sharp (interop/react-factory TitleSharp))
(def title-two-tone (interop/react-factory TitleTwoTone))
(def toc (interop/react-factory Toc))
(def toc-outlined (interop/react-factory TocOutlined))
(def toc-rounded (interop/react-factory TocRounded))
(def toc-sharp (interop/react-factory TocSharp))
(def toc-two-tone (interop/react-factory TocTwoTone))
(def today (interop/react-factory Today))
(def today-outlined (interop/react-factory TodayOutlined))
(def today-rounded (interop/react-factory TodayRounded))
(def today-sharp (interop/react-factory TodaySharp))
(def today-two-tone (interop/react-factory TodayTwoTone))
(def toggle-off (interop/react-factory ToggleOff))
(def toggle-off-outlined (interop/react-factory ToggleOffOutlined))
(def toggle-off-rounded (interop/react-factory ToggleOffRounded))
(def toggle-off-sharp (interop/react-factory ToggleOffSharp))
(def toggle-off-two-tone (interop/react-factory ToggleOffTwoTone))
(def toggle-on (interop/react-factory ToggleOn))
(def toggle-on-outlined (interop/react-factory ToggleOnOutlined))
(def toggle-on-rounded (interop/react-factory ToggleOnRounded))
(def toggle-on-sharp (interop/react-factory ToggleOnSharp))
(def toggle-on-two-tone (interop/react-factory ToggleOnTwoTone))
(def toll (interop/react-factory Toll))
(def toll-outlined (interop/react-factory TollOutlined))
(def toll-rounded (interop/react-factory TollRounded))
(def toll-sharp (interop/react-factory TollSharp))
(def toll-two-tone (interop/react-factory TollTwoTone))
(def tonality (interop/react-factory Tonality))
(def tonality-outlined (interop/react-factory TonalityOutlined))
(def tonality-rounded (interop/react-factory TonalityRounded))
(def tonality-sharp (interop/react-factory TonalitySharp))
(def tonality-two-tone (interop/react-factory TonalityTwoTone))
(def touch-app (interop/react-factory TouchApp))
(def touch-app-outlined (interop/react-factory TouchAppOutlined))
(def touch-app-rounded (interop/react-factory TouchAppRounded))
(def touch-app-sharp (interop/react-factory TouchAppSharp))
(def touch-app-two-tone (interop/react-factory TouchAppTwoTone))
(def toys (interop/react-factory Toys))
(def toys-outlined (interop/react-factory ToysOutlined))
(def toys-rounded (interop/react-factory ToysRounded))
(def toys-sharp (interop/react-factory ToysSharp))
(def toys-two-tone (interop/react-factory ToysTwoTone))
(def track-changes (interop/react-factory TrackChanges))
(def track-changes-outlined (interop/react-factory TrackChangesOutlined))
(def track-changes-rounded (interop/react-factory TrackChangesRounded))
(def track-changes-sharp (interop/react-factory TrackChangesSharp))
(def track-changes-two-tone (interop/react-factory TrackChangesTwoTone))
(def traffic (interop/react-factory Traffic))
(def traffic-outlined (interop/react-factory TrafficOutlined))
(def traffic-rounded (interop/react-factory TrafficRounded))
(def traffic-sharp (interop/react-factory TrafficSharp))
(def traffic-two-tone (interop/react-factory TrafficTwoTone))
(def train (interop/react-factory Train))
(def train-outlined (interop/react-factory TrainOutlined))
(def train-rounded (interop/react-factory TrainRounded))
(def train-sharp (interop/react-factory TrainSharp))
(def train-two-tone (interop/react-factory TrainTwoTone))
(def tram (interop/react-factory Tram))
(def tram-outlined (interop/react-factory TramOutlined))
(def tram-rounded (interop/react-factory TramRounded))
(def tram-sharp (interop/react-factory TramSharp))
(def tram-two-tone (interop/react-factory TramTwoTone))
(def transfer-within-a-station (interop/react-factory TransferWithinAStation))
(def transfer-within-a-station-outlined (interop/react-factory TransferWithinAStationOutlined))
(def transfer-within-a-station-rounded (interop/react-factory TransferWithinAStationRounded))
(def transfer-within-a-station-sharp (interop/react-factory TransferWithinAStationSharp))
(def transfer-within-a-station-two-tone (interop/react-factory TransferWithinAStationTwoTone))
(def transform (interop/react-factory Transform))
(def transform-outlined (interop/react-factory TransformOutlined))
(def transform-rounded (interop/react-factory TransformRounded))
(def transform-sharp (interop/react-factory TransformSharp))
(def transform-two-tone (interop/react-factory TransformTwoTone))
(def transit-enterexit (interop/react-factory TransitEnterexit))
(def transit-enterexit-outlined (interop/react-factory TransitEnterexitOutlined))
(def transit-enterexit-rounded (interop/react-factory TransitEnterexitRounded))
(def transit-enterexit-sharp (interop/react-factory TransitEnterexitSharp))
(def transit-enterexit-two-tone (interop/react-factory TransitEnterexitTwoTone))
(def translate (interop/react-factory Translate))
(def translate-outlined (interop/react-factory TranslateOutlined))
(def translate-rounded (interop/react-factory TranslateRounded))
(def translate-sharp (interop/react-factory TranslateSharp))
(def translate-two-tone (interop/react-factory TranslateTwoTone))
(def trending-down (interop/react-factory TrendingDown))
(def trending-down-outlined (interop/react-factory TrendingDownOutlined))
(def trending-down-rounded (interop/react-factory TrendingDownRounded))
(def trending-down-sharp (interop/react-factory TrendingDownSharp))
(def trending-down-two-tone (interop/react-factory TrendingDownTwoTone))
(def trending-flat (interop/react-factory TrendingFlat))
(def trending-flat-outlined (interop/react-factory TrendingFlatOutlined))
(def trending-flat-rounded (interop/react-factory TrendingFlatRounded))
(def trending-flat-sharp (interop/react-factory TrendingFlatSharp))
(def trending-flat-two-tone (interop/react-factory TrendingFlatTwoTone))
(def trending-up (interop/react-factory TrendingUp))
(def trending-up-outlined (interop/react-factory TrendingUpOutlined))
(def trending-up-rounded (interop/react-factory TrendingUpRounded))
(def trending-up-sharp (interop/react-factory TrendingUpSharp))
(def trending-up-two-tone (interop/react-factory TrendingUpTwoTone))
(def trip-origin (interop/react-factory TripOrigin))
(def trip-origin-outlined (interop/react-factory TripOriginOutlined))
(def trip-origin-rounded (interop/react-factory TripOriginRounded))
(def trip-origin-sharp (interop/react-factory TripOriginSharp))
(def trip-origin-two-tone (interop/react-factory TripOriginTwoTone))
(def tune (interop/react-factory Tune))
(def tune-outlined (interop/react-factory TuneOutlined))
(def tune-rounded (interop/react-factory TuneRounded))
(def tune-sharp (interop/react-factory TuneSharp))
(def tune-two-tone (interop/react-factory TuneTwoTone))
(def turned-in (interop/react-factory TurnedIn))
(def turned-in-not (interop/react-factory TurnedInNot))
(def turned-in-not-outlined (interop/react-factory TurnedInNotOutlined))
(def turned-in-not-rounded (interop/react-factory TurnedInNotRounded))
(def turned-in-not-sharp (interop/react-factory TurnedInNotSharp))
(def turned-in-not-two-tone (interop/react-factory TurnedInNotTwoTone))
(def turned-in-outlined (interop/react-factory TurnedInOutlined))
(def turned-in-rounded (interop/react-factory TurnedInRounded))
(def turned-in-sharp (interop/react-factory TurnedInSharp))
(def turned-in-two-tone (interop/react-factory TurnedInTwoTone))
(def tv (interop/react-factory Tv))
(def tv-off (interop/react-factory TvOff))
(def tv-off-outlined (interop/react-factory TvOffOutlined))
(def tv-off-rounded (interop/react-factory TvOffRounded))
(def tv-off-sharp (interop/react-factory TvOffSharp))
(def tv-off-two-tone (interop/react-factory TvOffTwoTone))
(def tv-outlined (interop/react-factory TvOutlined))
(def tv-rounded (interop/react-factory TvRounded))
(def tv-sharp (interop/react-factory TvSharp))
(def tv-two-tone (interop/react-factory TvTwoTone))
(def twitter (interop/react-factory Twitter))
(def unarchive (interop/react-factory Unarchive))
(def unarchive-outlined (interop/react-factory UnarchiveOutlined))
(def unarchive-rounded (interop/react-factory UnarchiveRounded))
(def unarchive-sharp (interop/react-factory UnarchiveSharp))
(def unarchive-two-tone (interop/react-factory UnarchiveTwoTone))
(def undo (interop/react-factory Undo))
(def undo-outlined (interop/react-factory UndoOutlined))
(def undo-rounded (interop/react-factory UndoRounded))
(def undo-sharp (interop/react-factory UndoSharp))
(def undo-two-tone (interop/react-factory UndoTwoTone))
(def unfold-less (interop/react-factory UnfoldLess))
(def unfold-less-outlined (interop/react-factory UnfoldLessOutlined))
(def unfold-less-rounded (interop/react-factory UnfoldLessRounded))
(def unfold-less-sharp (interop/react-factory UnfoldLessSharp))
(def unfold-less-two-tone (interop/react-factory UnfoldLessTwoTone))
(def unfold-more (interop/react-factory UnfoldMore))
(def unfold-more-outlined (interop/react-factory UnfoldMoreOutlined))
(def unfold-more-rounded (interop/react-factory UnfoldMoreRounded))
(def unfold-more-sharp (interop/react-factory UnfoldMoreSharp))
(def unfold-more-two-tone (interop/react-factory UnfoldMoreTwoTone))
(def unsubscribe (interop/react-factory Unsubscribe))
(def unsubscribe-outlined (interop/react-factory UnsubscribeOutlined))
(def unsubscribe-rounded (interop/react-factory UnsubscribeRounded))
(def unsubscribe-sharp (interop/react-factory UnsubscribeSharp))
(def unsubscribe-two-tone (interop/react-factory UnsubscribeTwoTone))
(def update (interop/react-factory Update))
(def update-outlined (interop/react-factory UpdateOutlined))
(def update-rounded (interop/react-factory UpdateRounded))
(def update-sharp (interop/react-factory UpdateSharp))
(def update-two-tone (interop/react-factory UpdateTwoTone))
(def usb (interop/react-factory Usb))
(def usb-outlined (interop/react-factory UsbOutlined))
(def usb-rounded (interop/react-factory UsbRounded))
(def usb-sharp (interop/react-factory UsbSharp))
(def usb-two-tone (interop/react-factory UsbTwoTone))
(def verified-user (interop/react-factory VerifiedUser))
(def verified-user-outlined (interop/react-factory VerifiedUserOutlined))
(def verified-user-rounded (interop/react-factory VerifiedUserRounded))
(def verified-user-sharp (interop/react-factory VerifiedUserSharp))
(def verified-user-two-tone (interop/react-factory VerifiedUserTwoTone))
(def vertical-align-bottom (interop/react-factory VerticalAlignBottom))
(def vertical-align-bottom-outlined (interop/react-factory VerticalAlignBottomOutlined))
(def vertical-align-bottom-rounded (interop/react-factory VerticalAlignBottomRounded))
(def vertical-align-bottom-sharp (interop/react-factory VerticalAlignBottomSharp))
(def vertical-align-bottom-two-tone (interop/react-factory VerticalAlignBottomTwoTone))
(def vertical-align-center (interop/react-factory VerticalAlignCenter))
(def vertical-align-center-outlined (interop/react-factory VerticalAlignCenterOutlined))
(def vertical-align-center-rounded (interop/react-factory VerticalAlignCenterRounded))
(def vertical-align-center-sharp (interop/react-factory VerticalAlignCenterSharp))
(def vertical-align-center-two-tone (interop/react-factory VerticalAlignCenterTwoTone))
(def vertical-align-top (interop/react-factory VerticalAlignTop))
(def vertical-align-top-outlined (interop/react-factory VerticalAlignTopOutlined))
(def vertical-align-top-rounded (interop/react-factory VerticalAlignTopRounded))
(def vertical-align-top-sharp (interop/react-factory VerticalAlignTopSharp))
(def vertical-align-top-two-tone (interop/react-factory VerticalAlignTopTwoTone))
(def vertical-split (interop/react-factory VerticalSplit))
(def vertical-split-outlined (interop/react-factory VerticalSplitOutlined))
(def vertical-split-rounded (interop/react-factory VerticalSplitRounded))
(def vertical-split-sharp (interop/react-factory VerticalSplitSharp))
(def vertical-split-two-tone (interop/react-factory VerticalSplitTwoTone))
(def vibration (interop/react-factory Vibration))
(def vibration-outlined (interop/react-factory VibrationOutlined))
(def vibration-rounded (interop/react-factory VibrationRounded))
(def vibration-sharp (interop/react-factory VibrationSharp))
(def vibration-two-tone (interop/react-factory VibrationTwoTone))
(def video-call (interop/react-factory VideoCall))
(def video-call-outlined (interop/react-factory VideoCallOutlined))
(def video-call-rounded (interop/react-factory VideoCallRounded))
(def video-call-sharp (interop/react-factory VideoCallSharp))
(def video-call-two-tone (interop/react-factory VideoCallTwoTone))
(def videocam (interop/react-factory Videocam))
(def videocam-off (interop/react-factory VideocamOff))
(def videocam-off-outlined (interop/react-factory VideocamOffOutlined))
(def videocam-off-rounded (interop/react-factory VideocamOffRounded))
(def videocam-off-sharp (interop/react-factory VideocamOffSharp))
(def videocam-off-two-tone (interop/react-factory VideocamOffTwoTone))
(def videocam-outlined (interop/react-factory VideocamOutlined))
(def videocam-rounded (interop/react-factory VideocamRounded))
(def videocam-sharp (interop/react-factory VideocamSharp))
(def videocam-two-tone (interop/react-factory VideocamTwoTone))
(def videogame-asset (interop/react-factory VideogameAsset))
(def videogame-asset-outlined (interop/react-factory VideogameAssetOutlined))
(def videogame-asset-rounded (interop/react-factory VideogameAssetRounded))
(def videogame-asset-sharp (interop/react-factory VideogameAssetSharp))
(def videogame-asset-two-tone (interop/react-factory VideogameAssetTwoTone))
(def video-label (interop/react-factory VideoLabel))
(def video-label-outlined (interop/react-factory VideoLabelOutlined))
(def video-label-rounded (interop/react-factory VideoLabelRounded))
(def video-label-sharp (interop/react-factory VideoLabelSharp))
(def video-label-two-tone (interop/react-factory VideoLabelTwoTone))
(def video-library (interop/react-factory VideoLibrary))
(def video-library-outlined (interop/react-factory VideoLibraryOutlined))
(def video-library-rounded (interop/react-factory VideoLibraryRounded))
(def video-library-sharp (interop/react-factory VideoLibrarySharp))
(def video-library-two-tone (interop/react-factory VideoLibraryTwoTone))
(def view-agenda (interop/react-factory ViewAgenda))
(def view-agenda-outlined (interop/react-factory ViewAgendaOutlined))
(def view-agenda-rounded (interop/react-factory ViewAgendaRounded))
(def view-agenda-sharp (interop/react-factory ViewAgendaSharp))
(def view-agenda-two-tone (interop/react-factory ViewAgendaTwoTone))
(def view-array (interop/react-factory ViewArray))
(def view-array-outlined (interop/react-factory ViewArrayOutlined))
(def view-array-rounded (interop/react-factory ViewArrayRounded))
(def view-array-sharp (interop/react-factory ViewArraySharp))
(def view-array-two-tone (interop/react-factory ViewArrayTwoTone))
(def view-carousel (interop/react-factory ViewCarousel))
(def view-carousel-outlined (interop/react-factory ViewCarouselOutlined))
(def view-carousel-rounded (interop/react-factory ViewCarouselRounded))
(def view-carousel-sharp (interop/react-factory ViewCarouselSharp))
(def view-carousel-two-tone (interop/react-factory ViewCarouselTwoTone))
(def view-column (interop/react-factory ViewColumn))
(def view-column-outlined (interop/react-factory ViewColumnOutlined))
(def view-column-rounded (interop/react-factory ViewColumnRounded))
(def view-column-sharp (interop/react-factory ViewColumnSharp))
(def view-column-two-tone (interop/react-factory ViewColumnTwoTone))
(def view-comfy (interop/react-factory ViewComfy))
(def view-comfy-outlined (interop/react-factory ViewComfyOutlined))
(def view-comfy-rounded (interop/react-factory ViewComfyRounded))
(def view-comfy-sharp (interop/react-factory ViewComfySharp))
(def view-comfy-two-tone (interop/react-factory ViewComfyTwoTone))
(def view-compact (interop/react-factory ViewCompact))
(def view-compact-outlined (interop/react-factory ViewCompactOutlined))
(def view-compact-rounded (interop/react-factory ViewCompactRounded))
(def view-compact-sharp (interop/react-factory ViewCompactSharp))
(def view-compact-two-tone (interop/react-factory ViewCompactTwoTone))
(def view-day (interop/react-factory ViewDay))
(def view-day-outlined (interop/react-factory ViewDayOutlined))
(def view-day-rounded (interop/react-factory ViewDayRounded))
(def view-day-sharp (interop/react-factory ViewDaySharp))
(def view-day-two-tone (interop/react-factory ViewDayTwoTone))
(def view-headline (interop/react-factory ViewHeadline))
(def view-headline-outlined (interop/react-factory ViewHeadlineOutlined))
(def view-headline-rounded (interop/react-factory ViewHeadlineRounded))
(def view-headline-sharp (interop/react-factory ViewHeadlineSharp))
(def view-headline-two-tone (interop/react-factory ViewHeadlineTwoTone))
(def view-list (interop/react-factory ViewList))
(def view-list-outlined (interop/react-factory ViewListOutlined))
(def view-list-rounded (interop/react-factory ViewListRounded))
(def view-list-sharp (interop/react-factory ViewListSharp))
(def view-list-two-tone (interop/react-factory ViewListTwoTone))
(def view-module (interop/react-factory ViewModule))
(def view-module-outlined (interop/react-factory ViewModuleOutlined))
(def view-module-rounded (interop/react-factory ViewModuleRounded))
(def view-module-sharp (interop/react-factory ViewModuleSharp))
(def view-module-two-tone (interop/react-factory ViewModuleTwoTone))
(def view-quilt (interop/react-factory ViewQuilt))
(def view-quilt-outlined (interop/react-factory ViewQuiltOutlined))
(def view-quilt-rounded (interop/react-factory ViewQuiltRounded))
(def view-quilt-sharp (interop/react-factory ViewQuiltSharp))
(def view-quilt-two-tone (interop/react-factory ViewQuiltTwoTone))
(def view-stream (interop/react-factory ViewStream))
(def view-stream-outlined (interop/react-factory ViewStreamOutlined))
(def view-stream-rounded (interop/react-factory ViewStreamRounded))
(def view-stream-sharp (interop/react-factory ViewStreamSharp))
(def view-stream-two-tone (interop/react-factory ViewStreamTwoTone))
(def view-week (interop/react-factory ViewWeek))
(def view-week-outlined (interop/react-factory ViewWeekOutlined))
(def view-week-rounded (interop/react-factory ViewWeekRounded))
(def view-week-sharp (interop/react-factory ViewWeekSharp))
(def view-week-two-tone (interop/react-factory ViewWeekTwoTone))
(def vignette (interop/react-factory Vignette))
(def vignette-outlined (interop/react-factory VignetteOutlined))
(def vignette-rounded (interop/react-factory VignetteRounded))
(def vignette-sharp (interop/react-factory VignetteSharp))
(def vignette-two-tone (interop/react-factory VignetteTwoTone))
(def visibility (interop/react-factory Visibility))
(def visibility-off (interop/react-factory VisibilityOff))
(def visibility-off-outlined (interop/react-factory VisibilityOffOutlined))
(def visibility-off-rounded (interop/react-factory VisibilityOffRounded))
(def visibility-off-sharp (interop/react-factory VisibilityOffSharp))
(def visibility-off-two-tone (interop/react-factory VisibilityOffTwoTone))
(def visibility-outlined (interop/react-factory VisibilityOutlined))
(def visibility-rounded (interop/react-factory VisibilityRounded))
(def visibility-sharp (interop/react-factory VisibilitySharp))
(def visibility-two-tone (interop/react-factory VisibilityTwoTone))
(def voice-chat (interop/react-factory VoiceChat))
(def voice-chat-outlined (interop/react-factory VoiceChatOutlined))
(def voice-chat-rounded (interop/react-factory VoiceChatRounded))
(def voice-chat-sharp (interop/react-factory VoiceChatSharp))
(def voice-chat-two-tone (interop/react-factory VoiceChatTwoTone))
(def voicemail (interop/react-factory Voicemail))
(def voicemail-outlined (interop/react-factory VoicemailOutlined))
(def voicemail-rounded (interop/react-factory VoicemailRounded))
(def voicemail-sharp (interop/react-factory VoicemailSharp))
(def voicemail-two-tone (interop/react-factory VoicemailTwoTone))
(def voice-over-off (interop/react-factory VoiceOverOff))
(def voice-over-off-outlined (interop/react-factory VoiceOverOffOutlined))
(def voice-over-off-rounded (interop/react-factory VoiceOverOffRounded))
(def voice-over-off-sharp (interop/react-factory VoiceOverOffSharp))
(def voice-over-off-two-tone (interop/react-factory VoiceOverOffTwoTone))
(def volume-down (interop/react-factory VolumeDown))
(def volume-down-outlined (interop/react-factory VolumeDownOutlined))
(def volume-down-rounded (interop/react-factory VolumeDownRounded))
(def volume-down-sharp (interop/react-factory VolumeDownSharp))
(def volume-down-two-tone (interop/react-factory VolumeDownTwoTone))
(def volume-mute (interop/react-factory VolumeMute))
(def volume-mute-outlined (interop/react-factory VolumeMuteOutlined))
(def volume-mute-rounded (interop/react-factory VolumeMuteRounded))
(def volume-mute-sharp (interop/react-factory VolumeMuteSharp))
(def volume-mute-two-tone (interop/react-factory VolumeMuteTwoTone))
(def volume-off (interop/react-factory VolumeOff))
(def volume-off-outlined (interop/react-factory VolumeOffOutlined))
(def volume-off-rounded (interop/react-factory VolumeOffRounded))
(def volume-off-sharp (interop/react-factory VolumeOffSharp))
(def volume-off-two-tone (interop/react-factory VolumeOffTwoTone))
(def volume-up (interop/react-factory VolumeUp))
(def volume-up-outlined (interop/react-factory VolumeUpOutlined))
(def volume-up-rounded (interop/react-factory VolumeUpRounded))
(def volume-up-sharp (interop/react-factory VolumeUpSharp))
(def volume-up-two-tone (interop/react-factory VolumeUpTwoTone))
(def vpn-key (interop/react-factory VpnKey))
(def vpn-key-outlined (interop/react-factory VpnKeyOutlined))
(def vpn-key-rounded (interop/react-factory VpnKeyRounded))
(def vpn-key-sharp (interop/react-factory VpnKeySharp))
(def vpn-key-two-tone (interop/react-factory VpnKeyTwoTone))
(def vpn-lock (interop/react-factory VpnLock))
(def vpn-lock-outlined (interop/react-factory VpnLockOutlined))
(def vpn-lock-rounded (interop/react-factory VpnLockRounded))
(def vpn-lock-sharp (interop/react-factory VpnLockSharp))
(def vpn-lock-two-tone (interop/react-factory VpnLockTwoTone))
(def wallpaper (interop/react-factory Wallpaper))
(def wallpaper-outlined (interop/react-factory WallpaperOutlined))
(def wallpaper-rounded (interop/react-factory WallpaperRounded))
(def wallpaper-sharp (interop/react-factory WallpaperSharp))
(def wallpaper-two-tone (interop/react-factory WallpaperTwoTone))
(def warning (interop/react-factory Warning))
(def warning-outlined (interop/react-factory WarningOutlined))
(def warning-rounded (interop/react-factory WarningRounded))
(def warning-sharp (interop/react-factory WarningSharp))
(def warning-two-tone (interop/react-factory WarningTwoTone))
(def watch (interop/react-factory Watch))
(def watch-later (interop/react-factory WatchLater))
(def watch-later-outlined (interop/react-factory WatchLaterOutlined))
(def watch-later-rounded (interop/react-factory WatchLaterRounded))
(def watch-later-sharp (interop/react-factory WatchLaterSharp))
(def watch-later-two-tone (interop/react-factory WatchLaterTwoTone))
(def watch-outlined (interop/react-factory WatchOutlined))
(def watch-rounded (interop/react-factory WatchRounded))
(def watch-sharp (interop/react-factory WatchSharp))
(def watch-two-tone (interop/react-factory WatchTwoTone))
(def waves (interop/react-factory Waves))
(def waves-outlined (interop/react-factory WavesOutlined))
(def waves-rounded (interop/react-factory WavesRounded))
(def waves-sharp (interop/react-factory WavesSharp))
(def waves-two-tone (interop/react-factory WavesTwoTone))
(def wb-auto (interop/react-factory WbAuto))
(def wb-auto-outlined (interop/react-factory WbAutoOutlined))
(def wb-auto-rounded (interop/react-factory WbAutoRounded))
(def wb-auto-sharp (interop/react-factory WbAutoSharp))
(def wb-auto-two-tone (interop/react-factory WbAutoTwoTone))
(def wb-cloudy (interop/react-factory WbCloudy))
(def wb-cloudy-outlined (interop/react-factory WbCloudyOutlined))
(def wb-cloudy-rounded (interop/react-factory WbCloudyRounded))
(def wb-cloudy-sharp (interop/react-factory WbCloudySharp))
(def wb-cloudy-two-tone (interop/react-factory WbCloudyTwoTone))
(def wb-incandescent (interop/react-factory WbIncandescent))
(def wb-incandescent-outlined (interop/react-factory WbIncandescentOutlined))
(def wb-incandescent-rounded (interop/react-factory WbIncandescentRounded))
(def wb-incandescent-sharp (interop/react-factory WbIncandescentSharp))
(def wb-incandescent-two-tone (interop/react-factory WbIncandescentTwoTone))
(def wb-iridescent (interop/react-factory WbIridescent))
(def wb-iridescent-outlined (interop/react-factory WbIridescentOutlined))
(def wb-iridescent-rounded (interop/react-factory WbIridescentRounded))
(def wb-iridescent-sharp (interop/react-factory WbIridescentSharp))
(def wb-iridescent-two-tone (interop/react-factory WbIridescentTwoTone))
(def wb-sunny (interop/react-factory WbSunny))
(def wb-sunny-outlined (interop/react-factory WbSunnyOutlined))
(def wb-sunny-rounded (interop/react-factory WbSunnyRounded))
(def wb-sunny-sharp (interop/react-factory WbSunnySharp))
(def wb-sunny-two-tone (interop/react-factory WbSunnyTwoTone))
(def wc (interop/react-factory Wc))
(def wc-outlined (interop/react-factory WcOutlined))
(def wc-rounded (interop/react-factory WcRounded))
(def wc-sharp (interop/react-factory WcSharp))
(def wc-two-tone (interop/react-factory WcTwoTone))
(def web (interop/react-factory Web))
(def web-asset (interop/react-factory WebAsset))
(def web-asset-outlined (interop/react-factory WebAssetOutlined))
(def web-asset-rounded (interop/react-factory WebAssetRounded))
(def web-asset-sharp (interop/react-factory WebAssetSharp))
(def web-asset-two-tone (interop/react-factory WebAssetTwoTone))
(def web-outlined (interop/react-factory WebOutlined))
(def web-rounded (interop/react-factory WebRounded))
(def web-sharp (interop/react-factory WebSharp))
(def web-two-tone (interop/react-factory WebTwoTone))
(def weekend (interop/react-factory Weekend))
(def weekend-outlined (interop/react-factory WeekendOutlined))
(def weekend-rounded (interop/react-factory WeekendRounded))
(def weekend-sharp (interop/react-factory WeekendSharp))
(def weekend-two-tone (interop/react-factory WeekendTwoTone))
(def whats-app (interop/react-factory WhatsApp))
(def whatshot (interop/react-factory Whatshot))
(def whatshot-outlined (interop/react-factory WhatshotOutlined))
(def whatshot-rounded (interop/react-factory WhatshotRounded))
(def whatshot-sharp (interop/react-factory WhatshotSharp))
(def whatshot-two-tone (interop/react-factory WhatshotTwoTone))
(def where-to-vote (interop/react-factory WhereToVote))
(def where-to-vote-outlined (interop/react-factory WhereToVoteOutlined))
(def where-to-vote-rounded (interop/react-factory WhereToVoteRounded))
(def where-to-vote-sharp (interop/react-factory WhereToVoteSharp))
(def where-to-vote-two-tone (interop/react-factory WhereToVoteTwoTone))
(def widgets (interop/react-factory Widgets))
(def widgets-outlined (interop/react-factory WidgetsOutlined))
(def widgets-rounded (interop/react-factory WidgetsRounded))
(def widgets-sharp (interop/react-factory WidgetsSharp))
(def widgets-two-tone (interop/react-factory WidgetsTwoTone))
(def wifi (interop/react-factory Wifi))
(def wifi-lock (interop/react-factory WifiLock))
(def wifi-lock-outlined (interop/react-factory WifiLockOutlined))
(def wifi-lock-rounded (interop/react-factory WifiLockRounded))
(def wifi-lock-sharp (interop/react-factory WifiLockSharp))
(def wifi-lock-two-tone (interop/react-factory WifiLockTwoTone))
(def wifi-off (interop/react-factory WifiOff))
(def wifi-off-outlined (interop/react-factory WifiOffOutlined))
(def wifi-off-rounded (interop/react-factory WifiOffRounded))
(def wifi-off-sharp (interop/react-factory WifiOffSharp))
(def wifi-off-two-tone (interop/react-factory WifiOffTwoTone))
(def wifi-outlined (interop/react-factory WifiOutlined))
(def wifi-rounded (interop/react-factory WifiRounded))
(def wifi-sharp (interop/react-factory WifiSharp))
(def wifi-tethering (interop/react-factory WifiTethering))
(def wifi-tethering-outlined (interop/react-factory WifiTetheringOutlined))
(def wifi-tethering-rounded (interop/react-factory WifiTetheringRounded))
(def wifi-tethering-sharp (interop/react-factory WifiTetheringSharp))
(def wifi-tethering-two-tone (interop/react-factory WifiTetheringTwoTone))
(def wifi-two-tone (interop/react-factory WifiTwoTone))
(def work (interop/react-factory Work))
(def work-off (interop/react-factory WorkOff))
(def work-off-outlined (interop/react-factory WorkOffOutlined))
(def work-off-rounded (interop/react-factory WorkOffRounded))
(def work-off-sharp (interop/react-factory WorkOffSharp))
(def work-off-two-tone (interop/react-factory WorkOffTwoTone))
(def work-outline (interop/react-factory WorkOutline))
(def work-outlined (interop/react-factory WorkOutlined))
(def work-outline-outlined (interop/react-factory WorkOutlineOutlined))
(def work-outline-rounded (interop/react-factory WorkOutlineRounded))
(def work-outline-sharp (interop/react-factory WorkOutlineSharp))
(def work-outline-two-tone (interop/react-factory WorkOutlineTwoTone))
(def work-rounded (interop/react-factory WorkRounded))
(def work-sharp (interop/react-factory WorkSharp))
(def work-two-tone (interop/react-factory WorkTwoTone))
(def wrap-text (interop/react-factory WrapText))
(def wrap-text-outlined (interop/react-factory WrapTextOutlined))
(def wrap-text-rounded (interop/react-factory WrapTextRounded))
(def wrap-text-sharp (interop/react-factory WrapTextSharp))
(def wrap-text-two-tone (interop/react-factory WrapTextTwoTone))
(def you-tube (interop/react-factory YouTube))
(def youtube-searched-for (interop/react-factory YoutubeSearchedFor))
(def youtube-searched-for-outlined (interop/react-factory YoutubeSearchedForOutlined))
(def youtube-searched-for-rounded (interop/react-factory YoutubeSearchedForRounded))
(def youtube-searched-for-sharp (interop/react-factory YoutubeSearchedForSharp))
(def youtube-searched-for-two-tone (interop/react-factory YoutubeSearchedForTwoTone))
(def zoom-in (interop/react-factory ZoomIn))
(def zoom-in-outlined (interop/react-factory ZoomInOutlined))
(def zoom-in-rounded (interop/react-factory ZoomInRounded))
(def zoom-in-sharp (interop/react-factory ZoomInSharp))
(def zoom-in-two-tone (interop/react-factory ZoomInTwoTone))
(def zoom-out (interop/react-factory ZoomOut))
(def zoom-out-map (interop/react-factory ZoomOutMap))
(def zoom-out-map-outlined (interop/react-factory ZoomOutMapOutlined))
(def zoom-out-map-rounded (interop/react-factory ZoomOutMapRounded))
(def zoom-out-map-sharp (interop/react-factory ZoomOutMapSharp))
(def zoom-out-map-two-tone (interop/react-factory ZoomOutMapTwoTone))
(def zoom-out-outlined (interop/react-factory ZoomOutOutlined))
(def zoom-out-rounded (interop/react-factory ZoomOutRounded))
(def zoom-out-sharp (interop/react-factory ZoomOutSharp))
(def zoom-out-two-tone (interop/react-factory ZoomOutTwoTone))
