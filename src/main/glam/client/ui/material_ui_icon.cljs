(ns glam.client.ui.material-ui-icon
  "Generated from this python code:

  def title2kebab(s):
      return \"\".join([
              '-' + c.lower() if c.isupper() and i != 0 else c.lower()
              for i, c in enumerate(s)
      ])
  for x in xs:
      print(f'[\"@material-ui/icons/{x}\" :default {x}]')
  print()
  for x in xs:
      print(f\"(def {title2kebab(x)} (interop/react-factory {x}))\")"
  (:refer-clojure :exclude [comment compare filter list loop map
                            print remove repeat shuffle sort update])
  (:require [com.fulcrologic.fulcro.algorithms.react-interop :as interop]
            ["@material-ui/icons/Menu" :default MenuIcon]
            ["@material-ui/icons/AcUnit" :default AcUnit]
            ["@material-ui/icons/AccessAlarm" :default AccessAlarm]
            ["@material-ui/icons/AccessAlarms" :default AccessAlarms]
            ["@material-ui/icons/AccessTime" :default AccessTime]
            ["@material-ui/icons/Accessibility" :default Accessibility]
            ["@material-ui/icons/AccessibilityNew" :default AccessibilityNew]
            ["@material-ui/icons/Accessible" :default Accessible]
            ["@material-ui/icons/AccessibleForward" :default AccessibleForward]
            ["@material-ui/icons/AccountBalance" :default AccountBalance]
            ["@material-ui/icons/AccountBalanceWallet" :default AccountBalanceWallet]
            ["@material-ui/icons/AccountBox" :default AccountBox]
            ["@material-ui/icons/AccountCircle" :default AccountCircle]
            ["@material-ui/icons/AccountTree" :default AccountTree]
            ["@material-ui/icons/Adb" :default Adb]
            ["@material-ui/icons/Add" :default Add]
            ["@material-ui/icons/AddAPhoto" :default AddAPhoto]
            ["@material-ui/icons/AddAlarm" :default AddAlarm]
            ["@material-ui/icons/AddAlert" :default AddAlert]
            ["@material-ui/icons/AddBox" :default AddBox]
            ["@material-ui/icons/AddCircle" :default AddCircle]
            ["@material-ui/icons/AddCircleOutline" :default AddCircleOutline]
            ["@material-ui/icons/AddComment" :default AddComment]
            ["@material-ui/icons/AddIcCall" :default AddIcCall]
            ["@material-ui/icons/AddLocation" :default AddLocation]
            ["@material-ui/icons/AddPhotoAlternate" :default AddPhotoAlternate]
            ["@material-ui/icons/AddShoppingCart" :default AddShoppingCart]
            ["@material-ui/icons/AddToHomeScreen" :default AddToHomeScreen]
            ["@material-ui/icons/AddToPhotos" :default AddToPhotos]
            ["@material-ui/icons/AddToQueue" :default AddToQueue]
            ["@material-ui/icons/Adjust" :default Adjust]
            ["@material-ui/icons/AirlineSeatFlat" :default AirlineSeatFlat]
            ["@material-ui/icons/AirlineSeatFlatAngled" :default AirlineSeatFlatAngled]
            ["@material-ui/icons/AirlineSeatIndividualSuite" :default AirlineSeatIndividualSuite]
            ["@material-ui/icons/AirlineSeatLegroomExtra" :default AirlineSeatLegroomExtra]
            ["@material-ui/icons/AirlineSeatLegroomNormal" :default AirlineSeatLegroomNormal]
            ["@material-ui/icons/AirlineSeatLegroomReduced" :default AirlineSeatLegroomReduced]
            ["@material-ui/icons/AirlineSeatReclineExtra" :default AirlineSeatReclineExtra]
            ["@material-ui/icons/AirlineSeatReclineNormal" :default AirlineSeatReclineNormal]
            ["@material-ui/icons/AirplanemodeActive" :default AirplanemodeActive]
            ["@material-ui/icons/AirplanemodeInactive" :default AirplanemodeInactive]
            ["@material-ui/icons/Airplay" :default Airplay]
            ["@material-ui/icons/AirportShuttle" :default AirportShuttle]
            ["@material-ui/icons/Alarm" :default Alarm]
            ["@material-ui/icons/AlarmAdd" :default AlarmAdd]
            ["@material-ui/icons/AlarmOff" :default AlarmOff]
            ["@material-ui/icons/AlarmOn" :default AlarmOn]
            ["@material-ui/icons/Album" :default Album]
            ["@material-ui/icons/AllInbox" :default AllInbox]
            ["@material-ui/icons/AllInclusive" :default AllInclusive]
            ["@material-ui/icons/AllOut" :default AllOut]
            ["@material-ui/icons/AlternateEmail" :default AlternateEmail]
            ["@material-ui/icons/AmpStories" :default AmpStories]
            ["@material-ui/icons/Android" :default Android]
            ["@material-ui/icons/Announcement" :default Announcement]
            ["@material-ui/icons/Apartment" :default Apartment]
            ["@material-ui/icons/Apple" :default Apple]
            ["@material-ui/icons/Apps" :default Apps]
            ["@material-ui/icons/Archive" :default Archive]
            ["@material-ui/icons/ArrowBack" :default ArrowBack]
            ["@material-ui/icons/ArrowBackIos" :default ArrowBackIos]
            ["@material-ui/icons/ArrowDownward" :default ArrowDownward]
            ["@material-ui/icons/ArrowDropDown" :default ArrowDropDown]
            ["@material-ui/icons/ArrowDropDownCircle" :default ArrowDropDownCircle]
            ["@material-ui/icons/ArrowDropUp" :default ArrowDropUp]
            ["@material-ui/icons/ArrowForward" :default ArrowForward]
            ["@material-ui/icons/ArrowForwardIos" :default ArrowForwardIos]
            ["@material-ui/icons/ArrowLeft" :default ArrowLeft]
            ["@material-ui/icons/ArrowRight" :default ArrowRight]
            ["@material-ui/icons/ArrowRightAlt" :default ArrowRightAlt]
            ["@material-ui/icons/ArrowUpward" :default ArrowUpward]
            ["@material-ui/icons/ArtTrack" :default ArtTrack]
            ["@material-ui/icons/AspectRatio" :default AspectRatio]
            ["@material-ui/icons/Assessment" :default Assessment]
            ["@material-ui/icons/Assignment" :default Assignment]
            ["@material-ui/icons/AssignmentInd" :default AssignmentInd]
            ["@material-ui/icons/AssignmentLate" :default AssignmentLate]
            ["@material-ui/icons/AssignmentReturn" :default AssignmentReturn]
            ["@material-ui/icons/AssignmentReturned" :default AssignmentReturned]
            ["@material-ui/icons/AssignmentTurnedIn" :default AssignmentTurnedIn]
            ["@material-ui/icons/Assistant" :default Assistant]
            ["@material-ui/icons/AssistantPhoto" :default AssistantPhoto]
            ["@material-ui/icons/Atm" :default Atm]
            ["@material-ui/icons/AttachFile" :default AttachFile]
            ["@material-ui/icons/AttachMoney" :default AttachMoney]
            ["@material-ui/icons/Attachment" :default Attachment]
            ["@material-ui/icons/Audiotrack" :default Audiotrack]
            ["@material-ui/icons/Autorenew" :default Autorenew]
            ["@material-ui/icons/AvTimer" :default AvTimer]
            ["@material-ui/icons/Backspace" :default Backspace]
            ["@material-ui/icons/Backup" :default Backup]
            ["@material-ui/icons/Ballot" :default Ballot]
            ["@material-ui/icons/BarChart" :default BarChart]
            ["@material-ui/icons/Bathtub" :default Bathtub]
            ["@material-ui/icons/Battery20" :default Battery20]
            ["@material-ui/icons/Battery30" :default Battery30]
            ["@material-ui/icons/Battery50" :default Battery50]
            ["@material-ui/icons/Battery60" :default Battery60]
            ["@material-ui/icons/Battery80" :default Battery80]
            ["@material-ui/icons/Battery90" :default Battery90]
            ["@material-ui/icons/BatteryAlert" :default BatteryAlert]
            ["@material-ui/icons/BatteryCharging20" :default BatteryCharging20]
            ["@material-ui/icons/BatteryCharging30" :default BatteryCharging30]
            ["@material-ui/icons/BatteryCharging50" :default BatteryCharging50]
            ["@material-ui/icons/BatteryCharging60" :default BatteryCharging60]
            ["@material-ui/icons/BatteryCharging80" :default BatteryCharging80]
            ["@material-ui/icons/BatteryCharging90" :default BatteryCharging90]
            ["@material-ui/icons/BatteryChargingFull" :default BatteryChargingFull]
            ["@material-ui/icons/BatteryFull" :default BatteryFull]
            ["@material-ui/icons/BatteryStd" :default BatteryStd]
            ["@material-ui/icons/BatteryUnknown" :default BatteryUnknown]
            ["@material-ui/icons/BeachAccess" :default BeachAccess]
            ["@material-ui/icons/Beenhere" :default Beenhere]
            ["@material-ui/icons/Block" :default Block]
            ["@material-ui/icons/Bluetooth" :default Bluetooth]
            ["@material-ui/icons/BluetoothAudio" :default BluetoothAudio]
            ["@material-ui/icons/BluetoothConnected" :default BluetoothConnected]
            ["@material-ui/icons/BluetoothDisabled" :default BluetoothDisabled]
            ["@material-ui/icons/BluetoothSearching" :default BluetoothSearching]
            ["@material-ui/icons/BlurCircular" :default BlurCircular]
            ["@material-ui/icons/BlurLinear" :default BlurLinear]
            ["@material-ui/icons/BlurOff" :default BlurOff]
            ["@material-ui/icons/BlurOn" :default BlurOn]
            ["@material-ui/icons/Book" :default Book]
            ["@material-ui/icons/Bookmark" :default Bookmark]
            ["@material-ui/icons/BookmarkBorder" :default BookmarkBorder]
            ["@material-ui/icons/Bookmarks" :default Bookmarks]
            ["@material-ui/icons/BorderAll" :default BorderAll]
            ["@material-ui/icons/BorderBottom" :default BorderBottom]
            ["@material-ui/icons/BorderClear" :default BorderClear]
            ["@material-ui/icons/BorderColor" :default BorderColor]
            ["@material-ui/icons/BorderHorizontal" :default BorderHorizontal]
            ["@material-ui/icons/BorderInner" :default BorderInner]
            ["@material-ui/icons/BorderLeft" :default BorderLeft]
            ["@material-ui/icons/BorderOuter" :default BorderOuter]
            ["@material-ui/icons/BorderRight" :default BorderRight]
            ["@material-ui/icons/BorderStyle" :default BorderStyle]
            ["@material-ui/icons/BorderTop" :default BorderTop]
            ["@material-ui/icons/BorderVertical" :default BorderVertical]
            ["@material-ui/icons/BrandingWatermark" :default BrandingWatermark]
            ["@material-ui/icons/Brightness1" :default Brightness1]
            ["@material-ui/icons/Brightness2" :default Brightness2]
            ["@material-ui/icons/Brightness3" :default Brightness3]
            ["@material-ui/icons/Brightness4" :default Brightness4]
            ["@material-ui/icons/Brightness5" :default Brightness5]
            ["@material-ui/icons/Brightness6" :default Brightness6]
            ["@material-ui/icons/Brightness7" :default Brightness7]
            ["@material-ui/icons/BrightnessAuto" :default BrightnessAuto]
            ["@material-ui/icons/BrightnessHigh" :default BrightnessHigh]
            ["@material-ui/icons/BrightnessLow" :default BrightnessLow]
            ["@material-ui/icons/BrightnessMedium" :default BrightnessMedium]
            ["@material-ui/icons/BrokenImage" :default BrokenImage]
            ["@material-ui/icons/Brush" :default Brush]
            ["@material-ui/icons/BubbleChart" :default BubbleChart]
            ["@material-ui/icons/BugReport" :default BugReport]
            ["@material-ui/icons/Build" :default Build]
            ["@material-ui/icons/BurstMode" :default BurstMode]
            ["@material-ui/icons/Business" :default Business]
            ["@material-ui/icons/BusinessCenter" :default BusinessCenter]
            ["@material-ui/icons/Cached" :default Cached]
            ["@material-ui/icons/Cake" :default Cake]
            ["@material-ui/icons/CalendarToday" :default CalendarToday]
            ["@material-ui/icons/CalendarViewDay" :default CalendarViewDay]
            ["@material-ui/icons/Call" :default Call]
            ["@material-ui/icons/CallEnd" :default CallEnd]
            ["@material-ui/icons/CallMade" :default CallMade]
            ["@material-ui/icons/CallMerge" :default CallMerge]
            ["@material-ui/icons/CallMissed" :default CallMissed]
            ["@material-ui/icons/CallMissedOutgoing" :default CallMissedOutgoing]
            ["@material-ui/icons/CallReceived" :default CallReceived]
            ["@material-ui/icons/CallSplit" :default CallSplit]
            ["@material-ui/icons/CallToAction" :default CallToAction]
            ["@material-ui/icons/Camera" :default Camera]
            ["@material-ui/icons/CameraAlt" :default CameraAlt]
            ["@material-ui/icons/CameraEnhance" :default CameraEnhance]
            ["@material-ui/icons/CameraFront" :default CameraFront]
            ["@material-ui/icons/CameraRear" :default CameraRear]
            ["@material-ui/icons/CameraRoll" :default CameraRoll]
            ["@material-ui/icons/Cancel" :default Cancel]
            ["@material-ui/icons/CancelPresentation" :default CancelPresentation]
            ["@material-ui/icons/CancelScheduleSend" :default CancelScheduleSend]
            ["@material-ui/icons/CardGiftcard" :default CardGiftcard]
            ["@material-ui/icons/CardMembership" :default CardMembership]
            ["@material-ui/icons/CardTravel" :default CardTravel]
            ["@material-ui/icons/Casino" :default Casino]
            ["@material-ui/icons/Cast" :default Cast]
            ["@material-ui/icons/CastConnected" :default CastConnected]
            ["@material-ui/icons/CastForEducation" :default CastForEducation]
            ["@material-ui/icons/Category" :default Category]
            ["@material-ui/icons/CellWifi" :default CellWifi]
            ["@material-ui/icons/CenterFocusStrong" :default CenterFocusStrong]
            ["@material-ui/icons/CenterFocusWeak" :default CenterFocusWeak]
            ["@material-ui/icons/ChangeHistory" :default ChangeHistory]
            ["@material-ui/icons/Chat" :default Chat]
            ["@material-ui/icons/ChatBubble" :default ChatBubble]
            ["@material-ui/icons/ChatBubbleOutline" :default ChatBubbleOutline]
            ["@material-ui/icons/Check" :default Check]
            ["@material-ui/icons/CheckBox" :default CheckBox]
            ["@material-ui/icons/CheckBoxOutlineBlank" :default CheckBoxOutlineBlank]
            ["@material-ui/icons/CheckCircle" :default CheckCircle]
            ["@material-ui/icons/CheckCircleOutline" :default CheckCircleOutline]
            ["@material-ui/icons/ChevronLeft" :default ChevronLeft]
            ["@material-ui/icons/ChevronRight" :default ChevronRight]
            ["@material-ui/icons/ChildCare" :default ChildCare]
            ["@material-ui/icons/ChildFriendly" :default ChildFriendly]
            ["@material-ui/icons/ChromeReaderMode" :default ChromeReaderMode]
            ["@material-ui/icons/Class" :default Class]
            ["@material-ui/icons/Clear" :default Clear]
            ["@material-ui/icons/ClearAll" :default ClearAll]
            ["@material-ui/icons/Close" :default Close]
            ["@material-ui/icons/ClosedCaption" :default ClosedCaption]
            ["@material-ui/icons/Cloud" :default Cloud]
            ["@material-ui/icons/CloudCircle" :default CloudCircle]
            ["@material-ui/icons/CloudDone" :default CloudDone]
            ["@material-ui/icons/CloudDownload" :default CloudDownload]
            ["@material-ui/icons/CloudOff" :default CloudOff]
            ["@material-ui/icons/CloudQueue" :default CloudQueue]
            ["@material-ui/icons/CloudUpload" :default CloudUpload]
            ["@material-ui/icons/Code" :default Code]
            ["@material-ui/icons/Collections" :default Collections]
            ["@material-ui/icons/CollectionsBookmark" :default CollectionsBookmark]
            ["@material-ui/icons/ColorLens" :default ColorLens]
            ["@material-ui/icons/Colorize" :default Colorize]
            ["@material-ui/icons/Comment" :default Comment]
            ["@material-ui/icons/Commute" :default Commute]
            ["@material-ui/icons/Compare" :default Compare]
            ["@material-ui/icons/CompareArrows" :default CompareArrows]
            ["@material-ui/icons/CompassCalibration" :default CompassCalibration]
            ["@material-ui/icons/Computer" :default Computer]
            ["@material-ui/icons/ConfirmationNumber" :default ConfirmationNumber]
            ["@material-ui/icons/ContactMail" :default ContactMail]
            ["@material-ui/icons/ContactPhone" :default ContactPhone]
            ["@material-ui/icons/ContactSupport" :default ContactSupport]
            ["@material-ui/icons/Contactless" :default Contactless]
            ["@material-ui/icons/Contacts" :default Contacts]
            ["@material-ui/icons/ControlCamera" :default ControlCamera]
            ["@material-ui/icons/ControlPoint" :default ControlPoint]
            ["@material-ui/icons/ControlPointDuplicate" :default ControlPointDuplicate]
            ["@material-ui/icons/Copyright" :default Copyright]
            ["@material-ui/icons/Create" :default Create]
            ["@material-ui/icons/CreateNewFolder" :default CreateNewFolder]
            ["@material-ui/icons/CreditCard" :default CreditCard]
            ["@material-ui/icons/Crop" :default Crop]
            ["@material-ui/icons/Crop169" :default Crop169]
            ["@material-ui/icons/Crop32" :default Crop32]
            ["@material-ui/icons/Crop54" :default Crop54]
            ["@material-ui/icons/Crop75" :default Crop75]
            ["@material-ui/icons/CropDin" :default CropDin]
            ["@material-ui/icons/CropFree" :default CropFree]
            ["@material-ui/icons/CropLandscape" :default CropLandscape]
            ["@material-ui/icons/CropOriginal" :default CropOriginal]
            ["@material-ui/icons/CropPortrait" :default CropPortrait]
            ["@material-ui/icons/CropRotate" :default CropRotate]
            ["@material-ui/icons/CropSquare" :default CropSquare]
            ["@material-ui/icons/Dashboard" :default Dashboard]
            ["@material-ui/icons/DataUsage" :default DataUsage]
            ["@material-ui/icons/DateRange" :default DateRange]
            ["@material-ui/icons/Deck" :default Deck]
            ["@material-ui/icons/Dehaze" :default Dehaze]
            ["@material-ui/icons/Delete" :default Delete]
            ["@material-ui/icons/DeleteForever" :default DeleteForever]
            ["@material-ui/icons/DeleteOutline" :default DeleteOutline]
            ["@material-ui/icons/DeleteSweep" :default DeleteSweep]
            ["@material-ui/icons/DepartureBoard" :default DepartureBoard]
            ["@material-ui/icons/Description" :default Description]
            ["@material-ui/icons/DesktopAccessDisabled" :default DesktopAccessDisabled]
            ["@material-ui/icons/DesktopMac" :default DesktopMac]
            ["@material-ui/icons/DesktopWindows" :default DesktopWindows]
            ["@material-ui/icons/Details" :default Details]
            ["@material-ui/icons/DeveloperBoard" :default DeveloperBoard]
            ["@material-ui/icons/DeveloperMode" :default DeveloperMode]
            ["@material-ui/icons/DeviceHub" :default DeviceHub]
            ["@material-ui/icons/DeviceUnknown" :default DeviceUnknown]
            ["@material-ui/icons/Devices" :default Devices]
            ["@material-ui/icons/DevicesOther" :default DevicesOther]
            ["@material-ui/icons/DialerSip" :default DialerSip]
            ["@material-ui/icons/Dialpad" :default Dialpad]
            ["@material-ui/icons/Directions" :default Directions]
            ["@material-ui/icons/DirectionsBike" :default DirectionsBike]
            ["@material-ui/icons/DirectionsBoat" :default DirectionsBoat]
            ["@material-ui/icons/DirectionsBus" :default DirectionsBus]
            ["@material-ui/icons/DirectionsCar" :default DirectionsCar]
            ["@material-ui/icons/DirectionsRailway" :default DirectionsRailway]
            ["@material-ui/icons/DirectionsRun" :default DirectionsRun]
            ["@material-ui/icons/DirectionsSubway" :default DirectionsSubway]
            ["@material-ui/icons/DirectionsTransit" :default DirectionsTransit]
            ["@material-ui/icons/DirectionsWalk" :default DirectionsWalk]
            ["@material-ui/icons/DiscFull" :default DiscFull]
            ["@material-ui/icons/Dns" :default Dns]
            ["@material-ui/icons/Dock" :default Dock]
            ["@material-ui/icons/Domain" :default Domain]
            ["@material-ui/icons/DomainDisabled" :default DomainDisabled]
            ["@material-ui/icons/Done" :default Done]
            ["@material-ui/icons/DoneAll" :default DoneAll]
            ["@material-ui/icons/DoneOutline" :default DoneOutline]
            ["@material-ui/icons/DonutLarge" :default DonutLarge]
            ["@material-ui/icons/DonutSmall" :default DonutSmall]
            ["@material-ui/icons/DoubleArrow" :default DoubleArrow]
            ["@material-ui/icons/Drafts" :default Drafts]
            ["@material-ui/icons/DragHandle" :default DragHandle]
            ["@material-ui/icons/DragIndicator" :default DragIndicator]
            ["@material-ui/icons/DriveEta" :default DriveEta]
            ["@material-ui/icons/Duo" :default Duo]
            ["@material-ui/icons/Dvr" :default Dvr]
            ["@material-ui/icons/DynamicFeed" :default DynamicFeed]
            ["@material-ui/icons/Eco" :default Eco]
            ["@material-ui/icons/Edit" :default Edit]
            ["@material-ui/icons/EditAttributes" :default EditAttributes]
            ["@material-ui/icons/EditLocation" :default EditLocation]
            ["@material-ui/icons/Eject" :default Eject]
            ["@material-ui/icons/Email" :default Email]
            ["@material-ui/icons/EmojiEmotions" :default EmojiEmotions]
            ["@material-ui/icons/EmojiEvents" :default EmojiEvents]
            ["@material-ui/icons/EmojiFlags" :default EmojiFlags]
            ["@material-ui/icons/EmojiFoodBeverage" :default EmojiFoodBeverage]
            ["@material-ui/icons/EmojiNature" :default EmojiNature]
            ["@material-ui/icons/EmojiObjects" :default EmojiObjects]
            ["@material-ui/icons/EmojiPeople" :default EmojiPeople]
            ["@material-ui/icons/EmojiSymbols" :default EmojiSymbols]
            ["@material-ui/icons/EmojiTransportation" :default EmojiTransportation]
            ["@material-ui/icons/EnhancedEncryption" :default EnhancedEncryption]
            ["@material-ui/icons/Equalizer" :default Equalizer]
            ["@material-ui/icons/Error" :default Error]
            ["@material-ui/icons/ErrorOutline" :default ErrorOutline]
            ["@material-ui/icons/Euro" :default Euro]
            ["@material-ui/icons/EuroSymbol" :default EuroSymbol]
            ["@material-ui/icons/EvStation" :default EvStation]
            ["@material-ui/icons/Event" :default Event]
            ["@material-ui/icons/EventAvailable" :default EventAvailable]
            ["@material-ui/icons/EventBusy" :default EventBusy]
            ["@material-ui/icons/EventNote" :default EventNote]
            ["@material-ui/icons/EventSeat" :default EventSeat]
            ["@material-ui/icons/ExitToApp" :default ExitToApp]
            ["@material-ui/icons/ExpandLess" :default ExpandLess]
            ["@material-ui/icons/ExpandMore" :default ExpandMore]
            ["@material-ui/icons/Explicit" :default Explicit]
            ["@material-ui/icons/Explore" :default Explore]
            ["@material-ui/icons/ExploreOff" :default ExploreOff]
            ["@material-ui/icons/Exposure" :default Exposure]
            ["@material-ui/icons/ExposureNeg1" :default ExposureNeg1]
            ["@material-ui/icons/ExposureNeg2" :default ExposureNeg2]
            ["@material-ui/icons/ExposurePlus1" :default ExposurePlus1]
            ["@material-ui/icons/ExposurePlus2" :default ExposurePlus2]
            ["@material-ui/icons/ExposureZero" :default ExposureZero]
            ["@material-ui/icons/Extension" :default Extension]
            ["@material-ui/icons/Face" :default Face]
            ["@material-ui/icons/Facebook" :default Facebook]
            ["@material-ui/icons/FastForward" :default FastForward]
            ["@material-ui/icons/FastRewind" :default FastRewind]
            ["@material-ui/icons/Fastfood" :default Fastfood]
            ["@material-ui/icons/Favorite" :default Favorite]
            ["@material-ui/icons/FavoriteBorder" :default FavoriteBorder]
            ["@material-ui/icons/FeaturedPlayList" :default FeaturedPlayList]
            ["@material-ui/icons/FeaturedVideo" :default FeaturedVideo]
            ["@material-ui/icons/Feedback" :default Feedback]
            ["@material-ui/icons/FiberDvr" :default FiberDvr]
            ["@material-ui/icons/FiberManualRecord" :default FiberManualRecord]
            ["@material-ui/icons/FiberNew" :default FiberNew]
            ["@material-ui/icons/FiberPin" :default FiberPin]
            ["@material-ui/icons/FiberSmartRecord" :default FiberSmartRecord]
            ["@material-ui/icons/FileCopy" :default FileCopy]
            ["@material-ui/icons/Filter" :default Filter]
            ["@material-ui/icons/Filter1" :default Filter1]
            ["@material-ui/icons/Filter2" :default Filter2]
            ["@material-ui/icons/Filter3" :default Filter3]
            ["@material-ui/icons/Filter4" :default Filter4]
            ["@material-ui/icons/Filter5" :default Filter5]
            ["@material-ui/icons/Filter6" :default Filter6]
            ["@material-ui/icons/Filter7" :default Filter7]
            ["@material-ui/icons/Filter8" :default Filter8]
            ["@material-ui/icons/Filter9" :default Filter9]
            ["@material-ui/icons/Filter9Plus" :default Filter9Plus]
            ["@material-ui/icons/FilterBAndW" :default FilterBAndW]
            ["@material-ui/icons/FilterCenterFocus" :default FilterCenterFocus]
            ["@material-ui/icons/FilterDrama" :default FilterDrama]
            ["@material-ui/icons/FilterFrames" :default FilterFrames]
            ["@material-ui/icons/FilterHdr" :default FilterHdr]
            ["@material-ui/icons/FilterList" :default FilterList]
            ["@material-ui/icons/FilterNone" :default FilterNone]
            ["@material-ui/icons/FilterTiltShift" :default FilterTiltShift]
            ["@material-ui/icons/FilterVintage" :default FilterVintage]
            ["@material-ui/icons/FindInPage" :default FindInPage]
            ["@material-ui/icons/FindReplace" :default FindReplace]
            ["@material-ui/icons/Fingerprint" :default Fingerprint]
            ["@material-ui/icons/Fireplace" :default Fireplace]
            ["@material-ui/icons/FirstPage" :default FirstPage]
            ["@material-ui/icons/FitnessCenter" :default FitnessCenter]
            ["@material-ui/icons/Flag" :default Flag]
            ["@material-ui/icons/Flare" :default Flare]
            ["@material-ui/icons/FlashAuto" :default FlashAuto]
            ["@material-ui/icons/FlashOff" :default FlashOff]
            ["@material-ui/icons/FlashOn" :default FlashOn]
            ["@material-ui/icons/Flight" :default Flight]
            ["@material-ui/icons/FlightLand" :default FlightLand]
            ["@material-ui/icons/FlightTakeoff" :default FlightTakeoff]
            ["@material-ui/icons/Flip" :default Flip]
            ["@material-ui/icons/FlipCameraAndroid" :default FlipCameraAndroid]
            ["@material-ui/icons/FlipCameraIos" :default FlipCameraIos]
            ["@material-ui/icons/FlipToBack" :default FlipToBack]
            ["@material-ui/icons/FlipToFront" :default FlipToFront]
            ["@material-ui/icons/Folder" :default Folder]
            ["@material-ui/icons/FolderOpen" :default FolderOpen]
            ["@material-ui/icons/FolderShared" :default FolderShared]
            ["@material-ui/icons/FolderSpecial" :default FolderSpecial]
            ["@material-ui/icons/FontDownload" :default FontDownload]
            ["@material-ui/icons/FormatAlignCenter" :default FormatAlignCenter]
            ["@material-ui/icons/FormatAlignJustify" :default FormatAlignJustify]
            ["@material-ui/icons/FormatAlignLeft" :default FormatAlignLeft]
            ["@material-ui/icons/FormatAlignRight" :default FormatAlignRight]
            ["@material-ui/icons/FormatBold" :default FormatBold]
            ["@material-ui/icons/FormatClear" :default FormatClear]
            ["@material-ui/icons/FormatColorFill" :default FormatColorFill]
            ["@material-ui/icons/FormatColorReset" :default FormatColorReset]
            ["@material-ui/icons/FormatColorText" :default FormatColorText]
            ["@material-ui/icons/FormatIndentDecrease" :default FormatIndentDecrease]
            ["@material-ui/icons/FormatIndentIncrease" :default FormatIndentIncrease]
            ["@material-ui/icons/FormatItalic" :default FormatItalic]
            ["@material-ui/icons/FormatLineSpacing" :default FormatLineSpacing]
            ["@material-ui/icons/FormatListBulleted" :default FormatListBulleted]
            ["@material-ui/icons/FormatListNumbered" :default FormatListNumbered]
            ["@material-ui/icons/FormatListNumberedRtl" :default FormatListNumberedRtl]
            ["@material-ui/icons/FormatPaint" :default FormatPaint]
            ["@material-ui/icons/FormatQuote" :default FormatQuote]
            ["@material-ui/icons/FormatShapes" :default FormatShapes]
            ["@material-ui/icons/FormatSize" :default FormatSize]
            ["@material-ui/icons/FormatStrikethrough" :default FormatStrikethrough]
            ["@material-ui/icons/FormatTextdirectionLToR" :default FormatTextdirectionLToR]
            ["@material-ui/icons/FormatTextdirectionRToL" :default FormatTextdirectionRToL]
            ["@material-ui/icons/FormatUnderlined" :default FormatUnderlined]
            ["@material-ui/icons/Forum" :default Forum]
            ["@material-ui/icons/Forward" :default Forward]
            ["@material-ui/icons/Forward10" :default Forward10]
            ["@material-ui/icons/Forward30" :default Forward30]
            ["@material-ui/icons/Forward5" :default Forward5]
            ["@material-ui/icons/FourK" :default FourK]
            ["@material-ui/icons/FreeBreakfast" :default FreeBreakfast]
            ["@material-ui/icons/Fullscreen" :default Fullscreen]
            ["@material-ui/icons/FullscreenExit" :default FullscreenExit]
            ["@material-ui/icons/Functions" :default Functions]
            ["@material-ui/icons/GTranslate" :default GTranslate]
            ["@material-ui/icons/Gamepad" :default Gamepad]
            ["@material-ui/icons/Games" :default Games]
            ["@material-ui/icons/Gavel" :default Gavel]
            ["@material-ui/icons/Gesture" :default Gesture]
            ["@material-ui/icons/GetApp" :default GetApp]
            ["@material-ui/icons/Gif" :default Gif]
            ["@material-ui/icons/GitHub" :default GitHub]
            ["@material-ui/icons/GolfCourse" :default GolfCourse]
            ["@material-ui/icons/GpsFixed" :default GpsFixed]
            ["@material-ui/icons/GpsNotFixed" :default GpsNotFixed]
            ["@material-ui/icons/GpsOff" :default GpsOff]
            ["@material-ui/icons/Grade" :default Grade]
            ["@material-ui/icons/Gradient" :default Gradient]
            ["@material-ui/icons/Grain" :default Grain]
            ["@material-ui/icons/GraphicEq" :default GraphicEq]
            ["@material-ui/icons/GridOff" :default GridOff]
            ["@material-ui/icons/GridOn" :default GridOn]
            ["@material-ui/icons/Group" :default Group]
            ["@material-ui/icons/GroupAdd" :default GroupAdd]
            ["@material-ui/icons/GroupWork" :default GroupWork]
            ["@material-ui/icons/Hd" :default Hd]
            ["@material-ui/icons/HdrOff" :default HdrOff]
            ["@material-ui/icons/HdrOn" :default HdrOn]
            ["@material-ui/icons/HdrStrong" :default HdrStrong]
            ["@material-ui/icons/HdrWeak" :default HdrWeak]
            ["@material-ui/icons/Headset" :default Headset]
            ["@material-ui/icons/HeadsetMic" :default HeadsetMic]
            ["@material-ui/icons/Healing" :default Healing]
            ["@material-ui/icons/Hearing" :default Hearing]
            ["@material-ui/icons/Height" :default Height]
            ["@material-ui/icons/Help" :default Help]
            ["@material-ui/icons/HelpOutline" :default HelpOutline]
            ["@material-ui/icons/HighQuality" :default HighQuality]
            ["@material-ui/icons/Highlight" :default Highlight]
            ["@material-ui/icons/HighlightOff" :default HighlightOff]
            ["@material-ui/icons/History" :default History]
            ["@material-ui/icons/Home" :default Home]
            ["@material-ui/icons/HomeWork" :default HomeWork]
            ["@material-ui/icons/HorizontalSplit" :default HorizontalSplit]
            ["@material-ui/icons/HotTub" :default HotTub]
            ["@material-ui/icons/Hotel" :default Hotel]
            ["@material-ui/icons/HourglassEmpty" :default HourglassEmpty]
            ["@material-ui/icons/HourglassFull" :default HourglassFull]
            ["@material-ui/icons/House" :default House]
            ["@material-ui/icons/HowToReg" :default HowToReg]
            ["@material-ui/icons/HowToVote" :default HowToVote]
            ["@material-ui/icons/Http" :default Http]
            ["@material-ui/icons/Https" :default Https]
            ["@material-ui/icons/Image" :default Image]
            ["@material-ui/icons/ImageAspectRatio" :default ImageAspectRatio]
            ["@material-ui/icons/ImageSearch" :default ImageSearch]
            ["@material-ui/icons/ImportContacts" :default ImportContacts]
            ["@material-ui/icons/ImportExport" :default ImportExport]
            ["@material-ui/icons/ImportantDevices" :default ImportantDevices]
            ["@material-ui/icons/Inbox" :default Inbox]
            ["@material-ui/icons/IndeterminateCheckBox" :default IndeterminateCheckBox]
            ["@material-ui/icons/Info" :default Info]
            ["@material-ui/icons/Input" :default Input]
            ["@material-ui/icons/InsertChart" :default InsertChart]
            ["@material-ui/icons/InsertComment" :default InsertComment]
            ["@material-ui/icons/InsertDriveFile" :default InsertDriveFile]
            ["@material-ui/icons/InsertEmoticon" :default InsertEmoticon]
            ["@material-ui/icons/InsertInvitation" :default InsertInvitation]
            ["@material-ui/icons/InsertLink" :default InsertLink]
            ["@material-ui/icons/InsertPhoto" :default InsertPhoto]
            ["@material-ui/icons/Instagram" :default Instagram]
            ["@material-ui/icons/InvertColors" :default InvertColors]
            ["@material-ui/icons/InvertColorsOff" :default InvertColorsOff]
            ["@material-ui/icons/Iso" :default Iso]
            ["@material-ui/icons/Keyboard" :default Keyboard]
            ["@material-ui/icons/KeyboardArrowDown" :default KeyboardArrowDown]
            ["@material-ui/icons/KeyboardArrowLeft" :default KeyboardArrowLeft]
            ["@material-ui/icons/KeyboardArrowRight" :default KeyboardArrowRight]
            ["@material-ui/icons/KeyboardArrowUp" :default KeyboardArrowUp]
            ["@material-ui/icons/KeyboardBackspace" :default KeyboardBackspace]
            ["@material-ui/icons/KeyboardCapslock" :default KeyboardCapslock]
            ["@material-ui/icons/KeyboardHide" :default KeyboardHide]
            ["@material-ui/icons/KeyboardReturn" :default KeyboardReturn]
            ["@material-ui/icons/KeyboardTab" :default KeyboardTab]
            ["@material-ui/icons/KeyboardVoice" :default KeyboardVoice]
            ["@material-ui/icons/KingBed" :default KingBed]
            ["@material-ui/icons/Kitchen" :default Kitchen]
            ["@material-ui/icons/Label" :default Label]
            ["@material-ui/icons/LabelImportant" :default LabelImportant]
            ["@material-ui/icons/LabelOff" :default LabelOff]
            ["@material-ui/icons/Landscape" :default Landscape]
            ["@material-ui/icons/Language" :default Language]
            ["@material-ui/icons/Laptop" :default Laptop]
            ["@material-ui/icons/LaptopChromebook" :default LaptopChromebook]
            ["@material-ui/icons/LaptopMac" :default LaptopMac]
            ["@material-ui/icons/LaptopWindows" :default LaptopWindows]
            ["@material-ui/icons/LastPage" :default LastPage]
            ["@material-ui/icons/Launch" :default Launch]
            ["@material-ui/icons/Layers" :default Layers]
            ["@material-ui/icons/LayersClear" :default LayersClear]
            ["@material-ui/icons/LeakAdd" :default LeakAdd]
            ["@material-ui/icons/LeakRemove" :default LeakRemove]
            ["@material-ui/icons/Lens" :default Lens]
            ["@material-ui/icons/LibraryAdd" :default LibraryAdd]
            ["@material-ui/icons/LibraryAddCheck" :default LibraryAddCheck]
            ["@material-ui/icons/LibraryBooks" :default LibraryBooks]
            ["@material-ui/icons/LibraryMusic" :default LibraryMusic]
            ["@material-ui/icons/LineStyle" :default LineStyle]
            ["@material-ui/icons/LineWeight" :default LineWeight]
            ["@material-ui/icons/LinearScale" :default LinearScale]
            ["@material-ui/icons/Link" :default Link]
            ["@material-ui/icons/LinkOff" :default LinkOff]
            ["@material-ui/icons/LinkedCamera" :default LinkedCamera]
            ["@material-ui/icons/LinkedIn" :default LinkedIn]
            ["@material-ui/icons/List" :default List]
            ["@material-ui/icons/ListAlt" :default ListAlt]
            ["@material-ui/icons/LiveHelp" :default LiveHelp]
            ["@material-ui/icons/LiveTv" :default LiveTv]
            ["@material-ui/icons/LocalActivity" :default LocalActivity]
            ["@material-ui/icons/LocalAirport" :default LocalAirport]
            ["@material-ui/icons/LocalAtm" :default LocalAtm]
            ["@material-ui/icons/LocalBar" :default LocalBar]
            ["@material-ui/icons/LocalCafe" :default LocalCafe]
            ["@material-ui/icons/LocalCarWash" :default LocalCarWash]
            ["@material-ui/icons/LocalConvenienceStore" :default LocalConvenienceStore]
            ["@material-ui/icons/LocalDining" :default LocalDining]
            ["@material-ui/icons/LocalDrink" :default LocalDrink]
            ["@material-ui/icons/LocalFlorist" :default LocalFlorist]
            ["@material-ui/icons/LocalGasStation" :default LocalGasStation]
            ["@material-ui/icons/LocalGroceryStore" :default LocalGroceryStore]
            ["@material-ui/icons/LocalHospital" :default LocalHospital]
            ["@material-ui/icons/LocalHotel" :default LocalHotel]
            ["@material-ui/icons/LocalLaundryService" :default LocalLaundryService]
            ["@material-ui/icons/LocalLibrary" :default LocalLibrary]
            ["@material-ui/icons/LocalMall" :default LocalMall]
            ["@material-ui/icons/LocalMovies" :default LocalMovies]
            ["@material-ui/icons/LocalOffer" :default LocalOffer]
            ["@material-ui/icons/LocalParking" :default LocalParking]
            ["@material-ui/icons/LocalPharmacy" :default LocalPharmacy]
            ["@material-ui/icons/LocalPhone" :default LocalPhone]
            ["@material-ui/icons/LocalPizza" :default LocalPizza]
            ["@material-ui/icons/LocalPlay" :default LocalPlay]
            ["@material-ui/icons/LocalPostOffice" :default LocalPostOffice]
            ["@material-ui/icons/LocalPrintshop" :default LocalPrintshop]
            ["@material-ui/icons/LocalSee" :default LocalSee]
            ["@material-ui/icons/LocalShipping" :default LocalShipping]
            ["@material-ui/icons/LocalTaxi" :default LocalTaxi]
            ["@material-ui/icons/LocationCity" :default LocationCity]
            ["@material-ui/icons/LocationDisabled" :default LocationDisabled]
            ["@material-ui/icons/LocationOff" :default LocationOff]
            ["@material-ui/icons/LocationOn" :default LocationOn]
            ["@material-ui/icons/LocationSearching" :default LocationSearching]
            ["@material-ui/icons/Lock" :default Lock]
            ["@material-ui/icons/LockOpen" :default LockOpen]
            ["@material-ui/icons/Looks" :default Looks]
            ["@material-ui/icons/Looks3" :default Looks3]
            ["@material-ui/icons/Looks4" :default Looks4]
            ["@material-ui/icons/Looks5" :default Looks5]
            ["@material-ui/icons/Looks6" :default Looks6]
            ["@material-ui/icons/LooksOne" :default LooksOne]
            ["@material-ui/icons/LooksTwo" :default LooksTwo]
            ["@material-ui/icons/Loop" :default Loop]
            ["@material-ui/icons/Loupe" :default Loupe]
            ["@material-ui/icons/LowPriority" :default LowPriority]
            ["@material-ui/icons/Loyalty" :default Loyalty]
            ["@material-ui/icons/Mail" :default Mail]
            ["@material-ui/icons/MailOutline" :default MailOutline]
            ["@material-ui/icons/Map" :default Map]
            ["@material-ui/icons/Markunread" :default Markunread]
            ["@material-ui/icons/MarkunreadMailbox" :default MarkunreadMailbox]
            ["@material-ui/icons/Maximize" :default Maximize]
            ["@material-ui/icons/MeetingRoom" :default MeetingRoom]
            ["@material-ui/icons/Memory" :default Memory]
            ["@material-ui/icons/Menu" :default Menu]
            ["@material-ui/icons/MenuBook" :default MenuBook]
            ["@material-ui/icons/MenuOpen" :default MenuOpen]
            ["@material-ui/icons/MergeType" :default MergeType]
            ["@material-ui/icons/Message" :default Message]
            ["@material-ui/icons/Mic" :default Mic]
            ["@material-ui/icons/MicNone" :default MicNone]
            ["@material-ui/icons/MicOff" :default MicOff]
            ["@material-ui/icons/Minimize" :default Minimize]
            ["@material-ui/icons/MissedVideoCall" :default MissedVideoCall]
            ["@material-ui/icons/Mms" :default Mms]
            ["@material-ui/icons/MobileFriendly" :default MobileFriendly]
            ["@material-ui/icons/MobileOff" :default MobileOff]
            ["@material-ui/icons/MobileScreenShare" :default MobileScreenShare]
            ["@material-ui/icons/ModeComment" :default ModeComment]
            ["@material-ui/icons/MonetizationOn" :default MonetizationOn]
            ["@material-ui/icons/Money" :default Money]
            ["@material-ui/icons/MoneyOff" :default MoneyOff]
            ["@material-ui/icons/MonochromePhotos" :default MonochromePhotos]
            ["@material-ui/icons/Mood" :default Mood]
            ["@material-ui/icons/MoodBad" :default MoodBad]
            ["@material-ui/icons/More" :default More]
            ["@material-ui/icons/MoreHoriz" :default MoreHoriz]
            ["@material-ui/icons/MoreVert" :default MoreVert]
            ["@material-ui/icons/Motorcycle" :default Motorcycle]
            ["@material-ui/icons/Mouse" :default Mouse]
            ["@material-ui/icons/MoveToInbox" :default MoveToInbox]
            ["@material-ui/icons/Movie" :default Movie]
            ["@material-ui/icons/MovieCreation" :default MovieCreation]
            ["@material-ui/icons/MovieFilter" :default MovieFilter]
            ["@material-ui/icons/MultilineChart" :default MultilineChart]
            ["@material-ui/icons/Museum" :default Museum]
            ["@material-ui/icons/MusicNote" :default MusicNote]
            ["@material-ui/icons/MusicOff" :default MusicOff]
            ["@material-ui/icons/MusicVideo" :default MusicVideo]
            ["@material-ui/icons/MyLocation" :default MyLocation]
            ["@material-ui/icons/Nature" :default Nature]
            ["@material-ui/icons/NaturePeople" :default NaturePeople]
            ["@material-ui/icons/NavigateBefore" :default NavigateBefore]
            ["@material-ui/icons/NavigateNext" :default NavigateNext]
            ["@material-ui/icons/Navigation" :default Navigation]
            ["@material-ui/icons/NearMe" :default NearMe]
            ["@material-ui/icons/NetworkCell" :default NetworkCell]
            ["@material-ui/icons/NetworkCheck" :default NetworkCheck]
            ["@material-ui/icons/NetworkLocked" :default NetworkLocked]
            ["@material-ui/icons/NetworkWifi" :default NetworkWifi]
            ["@material-ui/icons/NewReleases" :default NewReleases]
            ["@material-ui/icons/NextWeek" :default NextWeek]
            ["@material-ui/icons/Nfc" :default Nfc]
            ["@material-ui/icons/NightsStay" :default NightsStay]
            ["@material-ui/icons/NoEncryption" :default NoEncryption]
            ["@material-ui/icons/NoMeetingRoom" :default NoMeetingRoom]
            ["@material-ui/icons/NoSim" :default NoSim]
            ["@material-ui/icons/NotInterested" :default NotInterested]
            ["@material-ui/icons/NotListedLocation" :default NotListedLocation]
            ["@material-ui/icons/Note" :default Note]
            ["@material-ui/icons/NoteAdd" :default NoteAdd]
            ["@material-ui/icons/Notes" :default Notes]
            ["@material-ui/icons/NotificationImportant" :default NotificationImportant]
            ["@material-ui/icons/Notifications" :default Notifications]
            ["@material-ui/icons/NotificationsActive" :default NotificationsActive]
            ["@material-ui/icons/NotificationsNone" :default NotificationsNone]
            ["@material-ui/icons/NotificationsOff" :default NotificationsOff]
            ["@material-ui/icons/NotificationsPaused" :default NotificationsPaused]
            ["@material-ui/icons/OfflineBolt" :default OfflineBolt]
            ["@material-ui/icons/OfflinePin" :default OfflinePin]
            ["@material-ui/icons/OndemandVideo" :default OndemandVideo]
            ["@material-ui/icons/Opacity" :default Opacity]
            ["@material-ui/icons/OpenInBrowser" :default OpenInBrowser]
            ["@material-ui/icons/OpenInNew" :default OpenInNew]
            ["@material-ui/icons/OpenWith" :default OpenWith]
            ["@material-ui/icons/OutdoorGrill" :default OutdoorGrill]
            ["@material-ui/icons/Pages" :default Pages]
            ["@material-ui/icons/Pageview" :default Pageview]
            ["@material-ui/icons/Palette" :default Palette]
            ["@material-ui/icons/PanTool" :default PanTool]
            ["@material-ui/icons/Panorama" :default Panorama]
            ["@material-ui/icons/PanoramaFishEye" :default PanoramaFishEye]
            ["@material-ui/icons/PanoramaHorizontal" :default PanoramaHorizontal]
            ["@material-ui/icons/PanoramaVertical" :default PanoramaVertical]
            ["@material-ui/icons/PanoramaWideAngle" :default PanoramaWideAngle]
            ["@material-ui/icons/PartyMode" :default PartyMode]
            ["@material-ui/icons/Pause" :default Pause]
            ["@material-ui/icons/PauseCircleFilled" :default PauseCircleFilled]
            ["@material-ui/icons/PauseCircleOutline" :default PauseCircleOutline]
            ["@material-ui/icons/PausePresentation" :default PausePresentation]
            ["@material-ui/icons/Payment" :default Payment]
            ["@material-ui/icons/People" :default People]
            ["@material-ui/icons/PeopleAlt" :default PeopleAlt]
            ["@material-ui/icons/PeopleOutline" :default PeopleOutline]
            ["@material-ui/icons/PermCameraMic" :default PermCameraMic]
            ["@material-ui/icons/PermContactCalendar" :default PermContactCalendar]
            ["@material-ui/icons/PermDataSetting" :default PermDataSetting]
            ["@material-ui/icons/PermDeviceInformation" :default PermDeviceInformation]
            ["@material-ui/icons/PermIdentity" :default PermIdentity]
            ["@material-ui/icons/PermMedia" :default PermMedia]
            ["@material-ui/icons/PermPhoneMsg" :default PermPhoneMsg]
            ["@material-ui/icons/PermScanWifi" :default PermScanWifi]
            ["@material-ui/icons/Person" :default Person]
            ["@material-ui/icons/PersonAdd" :default PersonAdd]
            ["@material-ui/icons/PersonAddDisabled" :default PersonAddDisabled]
            ["@material-ui/icons/PersonOutline" :default PersonOutline]
            ["@material-ui/icons/PersonPin" :default PersonPin]
            ["@material-ui/icons/PersonPinCircle" :default PersonPinCircle]
            ["@material-ui/icons/PersonalVideo" :default PersonalVideo]
            ["@material-ui/icons/Pets" :default Pets]
            ["@material-ui/icons/Phone" :default Phone]
            ["@material-ui/icons/PhoneAndroid" :default PhoneAndroid]
            ["@material-ui/icons/PhoneBluetoothSpeaker" :default PhoneBluetoothSpeaker]
            ["@material-ui/icons/PhoneCallback" :default PhoneCallback]
            ["@material-ui/icons/PhoneDisabled" :default PhoneDisabled]
            ["@material-ui/icons/PhoneEnabled" :default PhoneEnabled]
            ["@material-ui/icons/PhoneForwarded" :default PhoneForwarded]
            ["@material-ui/icons/PhoneInTalk" :default PhoneInTalk]
            ["@material-ui/icons/PhoneIphone" :default PhoneIphone]
            ["@material-ui/icons/PhoneLocked" :default PhoneLocked]
            ["@material-ui/icons/PhoneMissed" :default PhoneMissed]
            ["@material-ui/icons/PhonePaused" :default PhonePaused]
            ["@material-ui/icons/Phonelink" :default Phonelink]
            ["@material-ui/icons/PhonelinkErase" :default PhonelinkErase]
            ["@material-ui/icons/PhonelinkLock" :default PhonelinkLock]
            ["@material-ui/icons/PhonelinkOff" :default PhonelinkOff]
            ["@material-ui/icons/PhonelinkRing" :default PhonelinkRing]
            ["@material-ui/icons/PhonelinkSetup" :default PhonelinkSetup]
            ["@material-ui/icons/Photo" :default Photo]
            ["@material-ui/icons/PhotoAlbum" :default PhotoAlbum]
            ["@material-ui/icons/PhotoCamera" :default PhotoCamera]
            ["@material-ui/icons/PhotoFilter" :default PhotoFilter]
            ["@material-ui/icons/PhotoLibrary" :default PhotoLibrary]
            ["@material-ui/icons/PhotoSizeSelectActual" :default PhotoSizeSelectActual]
            ["@material-ui/icons/PhotoSizeSelectLarge" :default PhotoSizeSelectLarge]
            ["@material-ui/icons/PhotoSizeSelectSmall" :default PhotoSizeSelectSmall]
            ["@material-ui/icons/PictureAsPdf" :default PictureAsPdf]
            ["@material-ui/icons/PictureInPicture" :default PictureInPicture]
            ["@material-ui/icons/PictureInPictureAlt" :default PictureInPictureAlt]
            ["@material-ui/icons/PieChart" :default PieChart]
            ["@material-ui/icons/PinDrop" :default PinDrop]
            ["@material-ui/icons/Pinterest" :default Pinterest]
            ["@material-ui/icons/Place" :default Place]
            ["@material-ui/icons/PlayArrow" :default PlayArrow]
            ["@material-ui/icons/PlayCircleFilled" :default PlayCircleFilled]
            ["@material-ui/icons/PlayCircleFilledWhite" :default PlayCircleFilledWhite]
            ["@material-ui/icons/PlayCircleOutline" :default PlayCircleOutline]
            ["@material-ui/icons/PlayForWork" :default PlayForWork]
            ["@material-ui/icons/PlaylistAdd" :default PlaylistAdd]
            ["@material-ui/icons/PlaylistAddCheck" :default PlaylistAddCheck]
            ["@material-ui/icons/PlaylistPlay" :default PlaylistPlay]
            ["@material-ui/icons/PlusOne" :default PlusOne]
            ["@material-ui/icons/Policy" :default Policy]
            ["@material-ui/icons/Poll" :default Poll]
            ["@material-ui/icons/Polymer" :default Polymer]
            ["@material-ui/icons/Pool" :default Pool]
            ["@material-ui/icons/PortableWifiOff" :default PortableWifiOff]
            ["@material-ui/icons/Portrait" :default Portrait]
            ["@material-ui/icons/PostAdd" :default PostAdd]
            ["@material-ui/icons/Power" :default Power]
            ["@material-ui/icons/PowerInput" :default PowerInput]
            ["@material-ui/icons/PowerOff" :default PowerOff]
            ["@material-ui/icons/PowerSettingsNew" :default PowerSettingsNew]
            ["@material-ui/icons/PregnantWoman" :default PregnantWoman]
            ["@material-ui/icons/PresentToAll" :default PresentToAll]
            ["@material-ui/icons/Print" :default Print]
            ["@material-ui/icons/PrintDisabled" :default PrintDisabled]
            ["@material-ui/icons/PriorityHigh" :default PriorityHigh]
            ["@material-ui/icons/Public" :default Public]
            ["@material-ui/icons/Publish" :default Publish]
            ["@material-ui/icons/QueryBuilder" :default QueryBuilder]
            ["@material-ui/icons/QuestionAnswer" :default QuestionAnswer]
            ["@material-ui/icons/Queue" :default Queue]
            ["@material-ui/icons/QueueMusic" :default QueueMusic]
            ["@material-ui/icons/QueuePlayNext" :default QueuePlayNext]
            ["@material-ui/icons/Radio" :default Radio]
            ["@material-ui/icons/RadioButtonChecked" :default RadioButtonChecked]
            ["@material-ui/icons/RadioButtonUnchecked" :default RadioButtonUnchecked]
            ["@material-ui/icons/RateReview" :default RateReview]
            ["@material-ui/icons/Receipt" :default Receipt]
            ["@material-ui/icons/RecentActors" :default RecentActors]
            ["@material-ui/icons/RecordVoiceOver" :default RecordVoiceOver]
            ["@material-ui/icons/Reddit" :default Reddit]
            ["@material-ui/icons/Redeem" :default Redeem]
            ["@material-ui/icons/Redo" :default Redo]
            ["@material-ui/icons/Refresh" :default Refresh]
            ["@material-ui/icons/Remove" :default Remove]
            ["@material-ui/icons/RemoveCircle" :default RemoveCircle]
            ["@material-ui/icons/RemoveCircleOutline" :default RemoveCircleOutline]
            ["@material-ui/icons/RemoveFromQueue" :default RemoveFromQueue]
            ["@material-ui/icons/RemoveRedEye" :default RemoveRedEye]
            ["@material-ui/icons/RemoveShoppingCart" :default RemoveShoppingCart]
            ["@material-ui/icons/Reorder" :default Reorder]
            ["@material-ui/icons/Repeat" :default Repeat]
            ["@material-ui/icons/RepeatOne" :default RepeatOne]
            ["@material-ui/icons/Replay" :default Replay]
            ["@material-ui/icons/Replay10" :default Replay10]
            ["@material-ui/icons/Replay30" :default Replay30]
            ["@material-ui/icons/Replay5" :default Replay5]
            ["@material-ui/icons/Reply" :default Reply]
            ["@material-ui/icons/ReplyAll" :default ReplyAll]
            ["@material-ui/icons/Report" :default Report]
            ["@material-ui/icons/ReportOff" :default ReportOff]
            ["@material-ui/icons/ReportProblem" :default ReportProblem]
            ["@material-ui/icons/Restaurant" :default Restaurant]
            ["@material-ui/icons/RestaurantMenu" :default RestaurantMenu]
            ["@material-ui/icons/Restore" :default Restore]
            ["@material-ui/icons/RestoreFromTrash" :default RestoreFromTrash]
            ["@material-ui/icons/RestorePage" :default RestorePage]
            ["@material-ui/icons/RingVolume" :default RingVolume]
            ["@material-ui/icons/Room" :default Room]
            ["@material-ui/icons/RoomService" :default RoomService]
            ["@material-ui/icons/Rotate90DegreesCcw" :default Rotate90DegreesCcw]
            ["@material-ui/icons/RotateLeft" :default RotateLeft]
            ["@material-ui/icons/RotateRight" :default RotateRight]
            ["@material-ui/icons/Router" :default Router]
            ["@material-ui/icons/Rowing" :default Rowing]
            ["@material-ui/icons/RssFeed" :default RssFeed]
            ["@material-ui/icons/RvHookup" :default RvHookup]
            ["@material-ui/icons/Satellite" :default Satellite]
            ["@material-ui/icons/Save" :default Save]
            ["@material-ui/icons/SaveAlt" :default SaveAlt]
            ["@material-ui/icons/Scanner" :default Scanner]
            ["@material-ui/icons/ScatterPlot" :default ScatterPlot]
            ["@material-ui/icons/Schedule" :default Schedule]
            ["@material-ui/icons/School" :default School]
            ["@material-ui/icons/Score" :default Score]
            ["@material-ui/icons/ScreenLockLandscape" :default ScreenLockLandscape]
            ["@material-ui/icons/ScreenLockPortrait" :default ScreenLockPortrait]
            ["@material-ui/icons/ScreenLockRotation" :default ScreenLockRotation]
            ["@material-ui/icons/ScreenRotation" :default ScreenRotation]
            ["@material-ui/icons/ScreenShare" :default ScreenShare]
            ["@material-ui/icons/SdCard" :default SdCard]
            ["@material-ui/icons/SdStorage" :default SdStorage]
            ["@material-ui/icons/Search" :default Search]
            ["@material-ui/icons/Security" :default Security]
            ["@material-ui/icons/SelectAll" :default SelectAll]
            ["@material-ui/icons/Send" :default Send]
            ["@material-ui/icons/SentimentDissatisfied" :default SentimentDissatisfied]
            ["@material-ui/icons/SentimentSatisfied" :default SentimentSatisfied]
            ["@material-ui/icons/SentimentSatisfiedAlt" :default SentimentSatisfiedAlt]
            ["@material-ui/icons/SentimentVeryDissatisfied" :default SentimentVeryDissatisfied]
            ["@material-ui/icons/SentimentVerySatisfied" :default SentimentVerySatisfied]
            ["@material-ui/icons/Settings" :default Settings]
            ["@material-ui/icons/SettingsApplications" :default SettingsApplications]
            ["@material-ui/icons/SettingsBackupRestore" :default SettingsBackupRestore]
            ["@material-ui/icons/SettingsBluetooth" :default SettingsBluetooth]
            ["@material-ui/icons/SettingsBrightness" :default SettingsBrightness]
            ["@material-ui/icons/SettingsCell" :default SettingsCell]
            ["@material-ui/icons/SettingsEthernet" :default SettingsEthernet]
            ["@material-ui/icons/SettingsInputAntenna" :default SettingsInputAntenna]
            ["@material-ui/icons/SettingsInputComponent" :default SettingsInputComponent]
            ["@material-ui/icons/SettingsInputComposite" :default SettingsInputComposite]
            ["@material-ui/icons/SettingsInputHdmi" :default SettingsInputHdmi]
            ["@material-ui/icons/SettingsInputSvideo" :default SettingsInputSvideo]
            ["@material-ui/icons/SettingsOverscan" :default SettingsOverscan]
            ["@material-ui/icons/SettingsPhone" :default SettingsPhone]
            ["@material-ui/icons/SettingsPower" :default SettingsPower]
            ["@material-ui/icons/SettingsRemote" :default SettingsRemote]
            ["@material-ui/icons/SettingsSystemDaydream" :default SettingsSystemDaydream]
            ["@material-ui/icons/SettingsVoice" :default SettingsVoice]
            ["@material-ui/icons/Share" :default Share]
            ["@material-ui/icons/Shop" :default Shop]
            ["@material-ui/icons/ShopTwo" :default ShopTwo]
            ["@material-ui/icons/ShoppingBasket" :default ShoppingBasket]
            ["@material-ui/icons/ShoppingCart" :default ShoppingCart]
            ["@material-ui/icons/ShortText" :default ShortText]
            ["@material-ui/icons/ShowChart" :default ShowChart]
            ["@material-ui/icons/Shuffle" :default Shuffle]
            ["@material-ui/icons/ShutterSpeed" :default ShutterSpeed]
            ["@material-ui/icons/SignalCellular0Bar" :default SignalCellular0Bar]
            ["@material-ui/icons/SignalCellular1Bar" :default SignalCellular1Bar]
            ["@material-ui/icons/SignalCellular2Bar" :default SignalCellular2Bar]
            ["@material-ui/icons/SignalCellular3Bar" :default SignalCellular3Bar]
            ["@material-ui/icons/SignalCellular4Bar" :default SignalCellular4Bar]
            ["@material-ui/icons/SignalCellularAlt" :default SignalCellularAlt]
            ["@material-ui/icons/SignalCellularConnectedNoInternet0Bar" :default SignalCellularConnectedNoInternet0Bar]
            ["@material-ui/icons/SignalCellularConnectedNoInternet1Bar" :default SignalCellularConnectedNoInternet1Bar]
            ["@material-ui/icons/SignalCellularConnectedNoInternet2Bar" :default SignalCellularConnectedNoInternet2Bar]
            ["@material-ui/icons/SignalCellularConnectedNoInternet3Bar" :default SignalCellularConnectedNoInternet3Bar]
            ["@material-ui/icons/SignalCellularConnectedNoInternet4Bar" :default SignalCellularConnectedNoInternet4Bar]
            ["@material-ui/icons/SignalCellularNoSim" :default SignalCellularNoSim]
            ["@material-ui/icons/SignalCellularNull" :default SignalCellularNull]
            ["@material-ui/icons/SignalCellularOff" :default SignalCellularOff]
            ["@material-ui/icons/SignalWifi0Bar" :default SignalWifi0Bar]
            ["@material-ui/icons/SignalWifi1Bar" :default SignalWifi1Bar]
            ["@material-ui/icons/SignalWifi1BarLock" :default SignalWifi1BarLock]
            ["@material-ui/icons/SignalWifi2Bar" :default SignalWifi2Bar]
            ["@material-ui/icons/SignalWifi2BarLock" :default SignalWifi2BarLock]
            ["@material-ui/icons/SignalWifi3Bar" :default SignalWifi3Bar]
            ["@material-ui/icons/SignalWifi3BarLock" :default SignalWifi3BarLock]
            ["@material-ui/icons/SignalWifi4Bar" :default SignalWifi4Bar]
            ["@material-ui/icons/SignalWifi4BarLock" :default SignalWifi4BarLock]
            ["@material-ui/icons/SignalWifiOff" :default SignalWifiOff]
            ["@material-ui/icons/SimCard" :default SimCard]
            ["@material-ui/icons/SingleBed" :default SingleBed]
            ["@material-ui/icons/SkipNext" :default SkipNext]
            ["@material-ui/icons/SkipPrevious" :default SkipPrevious]
            ["@material-ui/icons/Slideshow" :default Slideshow]
            ["@material-ui/icons/SlowMotionVideo" :default SlowMotionVideo]
            ["@material-ui/icons/Smartphone" :default Smartphone]
            ["@material-ui/icons/SmokeFree" :default SmokeFree]
            ["@material-ui/icons/SmokingRooms" :default SmokingRooms]
            ["@material-ui/icons/Sms" :default Sms]
            ["@material-ui/icons/SmsFailed" :default SmsFailed]
            ["@material-ui/icons/Snooze" :default Snooze]
            ["@material-ui/icons/Sort" :default Sort]
            ["@material-ui/icons/SortByAlpha" :default SortByAlpha]
            ["@material-ui/icons/Spa" :default Spa]
            ["@material-ui/icons/SpaceBar" :default SpaceBar]
            ["@material-ui/icons/Speaker" :default Speaker]
            ["@material-ui/icons/SpeakerGroup" :default SpeakerGroup]
            ["@material-ui/icons/SpeakerNotes" :default SpeakerNotes]
            ["@material-ui/icons/SpeakerNotesOff" :default SpeakerNotesOff]
            ["@material-ui/icons/SpeakerPhone" :default SpeakerPhone]
            ["@material-ui/icons/Speed" :default Speed]
            ["@material-ui/icons/Spellcheck" :default Spellcheck]
            ["@material-ui/icons/Sports" :default Sports]
            ["@material-ui/icons/SportsBaseball" :default SportsBaseball]
            ["@material-ui/icons/SportsBasketball" :default SportsBasketball]
            ["@material-ui/icons/SportsCricket" :default SportsCricket]
            ["@material-ui/icons/SportsEsports" :default SportsEsports]
            ["@material-ui/icons/SportsFootball" :default SportsFootball]
            ["@material-ui/icons/SportsGolf" :default SportsGolf]
            ["@material-ui/icons/SportsHandball" :default SportsHandball]
            ["@material-ui/icons/SportsHockey" :default SportsHockey]
            ["@material-ui/icons/SportsKabaddi" :default SportsKabaddi]
            ["@material-ui/icons/SportsMma" :default SportsMma]
            ["@material-ui/icons/SportsMotorsports" :default SportsMotorsports]
            ["@material-ui/icons/SportsRugby" :default SportsRugby]
            ["@material-ui/icons/SportsSoccer" :default SportsSoccer]
            ["@material-ui/icons/SportsTennis" :default SportsTennis]
            ["@material-ui/icons/SportsVolleyball" :default SportsVolleyball]
            ["@material-ui/icons/SquareFoot" :default SquareFoot]
            ["@material-ui/icons/Star" :default Star]
            ["@material-ui/icons/StarBorder" :default StarBorder]
            ["@material-ui/icons/StarHalf" :default StarHalf]
            ["@material-ui/icons/StarRate" :default StarRate]
            ["@material-ui/icons/Stars" :default Stars]
            ["@material-ui/icons/StayCurrentLandscape" :default StayCurrentLandscape]
            ["@material-ui/icons/StayCurrentPortrait" :default StayCurrentPortrait]
            ["@material-ui/icons/StayPrimaryLandscape" :default StayPrimaryLandscape]
            ["@material-ui/icons/StayPrimaryPortrait" :default StayPrimaryPortrait]
            ["@material-ui/icons/Stop" :default Stop]
            ["@material-ui/icons/StopScreenShare" :default StopScreenShare]
            ["@material-ui/icons/Storage" :default Storage]
            ["@material-ui/icons/Store" :default Store]
            ["@material-ui/icons/StoreMallDirectory" :default StoreMallDirectory]
            ["@material-ui/icons/Storefront" :default Storefront]
            ["@material-ui/icons/Straighten" :default Straighten]
            ["@material-ui/icons/Streetview" :default Streetview]
            ["@material-ui/icons/StrikethroughS" :default StrikethroughS]
            ["@material-ui/icons/Style" :default Style]
            ["@material-ui/icons/SubdirectoryArrowLeft" :default SubdirectoryArrowLeft]
            ["@material-ui/icons/SubdirectoryArrowRight" :default SubdirectoryArrowRight]
            ["@material-ui/icons/Subject" :default Subject]
            ["@material-ui/icons/Subscriptions" :default Subscriptions]
            ["@material-ui/icons/Subtitles" :default Subtitles]
            ["@material-ui/icons/Subway" :default Subway]
            ["@material-ui/icons/SupervisedUserCircle" :default SupervisedUserCircle]
            ["@material-ui/icons/SupervisorAccount" :default SupervisorAccount]
            ["@material-ui/icons/SurroundSound" :default SurroundSound]
            ["@material-ui/icons/SwapCalls" :default SwapCalls]
            ["@material-ui/icons/SwapHoriz" :default SwapHoriz]
            ["@material-ui/icons/SwapHorizontalCircle" :default SwapHorizontalCircle]
            ["@material-ui/icons/SwapVert" :default SwapVert]
            ["@material-ui/icons/SwapVerticalCircle" :default SwapVerticalCircle]
            ["@material-ui/icons/SwitchCamera" :default SwitchCamera]
            ["@material-ui/icons/SwitchVideo" :default SwitchVideo]
            ["@material-ui/icons/Sync" :default Sync]
            ["@material-ui/icons/SyncAlt" :default SyncAlt]
            ["@material-ui/icons/SyncDisabled" :default SyncDisabled]
            ["@material-ui/icons/SyncProblem" :default SyncProblem]
            ["@material-ui/icons/SystemUpdate" :default SystemUpdate]
            ["@material-ui/icons/SystemUpdateAlt" :default SystemUpdateAlt]
            ["@material-ui/icons/Tab" :default Tab]
            ["@material-ui/icons/TabUnselected" :default TabUnselected]
            ["@material-ui/icons/TableChart" :default TableChart]
            ["@material-ui/icons/Tablet" :default Tablet]
            ["@material-ui/icons/TabletAndroid" :default TabletAndroid]
            ["@material-ui/icons/TabletMac" :default TabletMac]
            ["@material-ui/icons/TagFaces" :default TagFaces]
            ["@material-ui/icons/TapAndPlay" :default TapAndPlay]
            ["@material-ui/icons/Telegram" :default Telegram]
            ["@material-ui/icons/Terrain" :default Terrain]
            ["@material-ui/icons/TextFields" :default TextFields]
            ["@material-ui/icons/TextFormat" :default TextFormat]
            ["@material-ui/icons/TextRotateUp" :default TextRotateUp]
            ["@material-ui/icons/TextRotateVertical" :default TextRotateVertical]
            ["@material-ui/icons/TextRotationAngledown" :default TextRotationAngledown]
            ["@material-ui/icons/TextRotationAngleup" :default TextRotationAngleup]
            ["@material-ui/icons/TextRotationDown" :default TextRotationDown]
            ["@material-ui/icons/TextRotationNone" :default TextRotationNone]
            ["@material-ui/icons/Textsms" :default Textsms]
            ["@material-ui/icons/Texture" :default Texture]
            ["@material-ui/icons/Theaters" :default Theaters]
            ["@material-ui/icons/ThreeDRotation" :default ThreeDRotation]
            ["@material-ui/icons/ThreeSixty" :default ThreeSixty]
            ["@material-ui/icons/ThumbDown" :default ThumbDown]
            ["@material-ui/icons/ThumbDownAlt" :default ThumbDownAlt]
            ["@material-ui/icons/ThumbUp" :default ThumbUp]
            ["@material-ui/icons/ThumbUpAlt" :default ThumbUpAlt]
            ["@material-ui/icons/ThumbsUpDown" :default ThumbsUpDown]
            ["@material-ui/icons/TimeToLeave" :default TimeToLeave]
            ["@material-ui/icons/Timelapse" :default Timelapse]
            ["@material-ui/icons/Timeline" :default Timeline]
            ["@material-ui/icons/Timer" :default Timer]
            ["@material-ui/icons/Timer10" :default Timer10]
            ["@material-ui/icons/Timer3" :default Timer3]
            ["@material-ui/icons/TimerOff" :default TimerOff]
            ["@material-ui/icons/Title" :default Title]
            ["@material-ui/icons/Toc" :default Toc]
            ["@material-ui/icons/Today" :default Today]
            ["@material-ui/icons/ToggleOff" :default ToggleOff]
            ["@material-ui/icons/ToggleOn" :default ToggleOn]
            ["@material-ui/icons/Toll" :default Toll]
            ["@material-ui/icons/Tonality" :default Tonality]
            ["@material-ui/icons/TouchApp" :default TouchApp]
            ["@material-ui/icons/Toys" :default Toys]
            ["@material-ui/icons/TrackChanges" :default TrackChanges]
            ["@material-ui/icons/Traffic" :default Traffic]
            ["@material-ui/icons/Train" :default Train]
            ["@material-ui/icons/Tram" :default Tram]
            ["@material-ui/icons/TransferWithinAStation" :default TransferWithinAStation]
            ["@material-ui/icons/Transform" :default Transform]
            ["@material-ui/icons/TransitEnterexit" :default TransitEnterexit]
            ["@material-ui/icons/Translate" :default Translate]
            ["@material-ui/icons/TrendingDown" :default TrendingDown]
            ["@material-ui/icons/TrendingFlat" :default TrendingFlat]
            ["@material-ui/icons/TrendingUp" :default TrendingUp]
            ["@material-ui/icons/TripOrigin" :default TripOrigin]
            ["@material-ui/icons/Tune" :default Tune]
            ["@material-ui/icons/TurnedIn" :default TurnedIn]
            ["@material-ui/icons/TurnedInNot" :default TurnedInNot]
            ["@material-ui/icons/Tv" :default Tv]
            ["@material-ui/icons/TvOff" :default TvOff]
            ["@material-ui/icons/Twitter" :default Twitter]
            ["@material-ui/icons/Unarchive" :default Unarchive]
            ["@material-ui/icons/Undo" :default Undo]
            ["@material-ui/icons/UnfoldLess" :default UnfoldLess]
            ["@material-ui/icons/UnfoldMore" :default UnfoldMore]
            ["@material-ui/icons/Unsubscribe" :default Unsubscribe]
            ["@material-ui/icons/Update" :default Update]
            ["@material-ui/icons/Usb" :default Usb]
            ["@material-ui/icons/VerifiedUser" :default VerifiedUser]
            ["@material-ui/icons/VerticalAlignBottom" :default VerticalAlignBottom]
            ["@material-ui/icons/VerticalAlignCenter" :default VerticalAlignCenter]
            ["@material-ui/icons/VerticalAlignTop" :default VerticalAlignTop]
            ["@material-ui/icons/VerticalSplit" :default VerticalSplit]
            ["@material-ui/icons/Vibration" :default Vibration]
            ["@material-ui/icons/VideoCall" :default VideoCall]
            ["@material-ui/icons/VideoLabel" :default VideoLabel]
            ["@material-ui/icons/VideoLibrary" :default VideoLibrary]
            ["@material-ui/icons/Videocam" :default Videocam]
            ["@material-ui/icons/VideocamOff" :default VideocamOff]
            ["@material-ui/icons/VideogameAsset" :default VideogameAsset]
            ["@material-ui/icons/ViewAgenda" :default ViewAgenda]
            ["@material-ui/icons/ViewArray" :default ViewArray]
            ["@material-ui/icons/ViewCarousel" :default ViewCarousel]
            ["@material-ui/icons/ViewColumn" :default ViewColumn]
            ["@material-ui/icons/ViewComfy" :default ViewComfy]
            ["@material-ui/icons/ViewCompact" :default ViewCompact]
            ["@material-ui/icons/ViewDay" :default ViewDay]
            ["@material-ui/icons/ViewHeadline" :default ViewHeadline]
            ["@material-ui/icons/ViewList" :default ViewList]
            ["@material-ui/icons/ViewModule" :default ViewModule]
            ["@material-ui/icons/ViewQuilt" :default ViewQuilt]
            ["@material-ui/icons/ViewStream" :default ViewStream]
            ["@material-ui/icons/ViewWeek" :default ViewWeek]
            ["@material-ui/icons/Vignette" :default Vignette]
            ["@material-ui/icons/Visibility" :default Visibility]
            ["@material-ui/icons/VisibilityOff" :default VisibilityOff]
            ["@material-ui/icons/VoiceChat" :default VoiceChat]
            ["@material-ui/icons/VoiceOverOff" :default VoiceOverOff]
            ["@material-ui/icons/Voicemail" :default Voicemail]
            ["@material-ui/icons/VolumeDown" :default VolumeDown]
            ["@material-ui/icons/VolumeMute" :default VolumeMute]
            ["@material-ui/icons/VolumeOff" :default VolumeOff]
            ["@material-ui/icons/VolumeUp" :default VolumeUp]
            ["@material-ui/icons/VpnKey" :default VpnKey]
            ["@material-ui/icons/VpnLock" :default VpnLock]
            ["@material-ui/icons/Wallpaper" :default Wallpaper]
            ["@material-ui/icons/Warning" :default Warning]
            ["@material-ui/icons/Watch" :default Watch]
            ["@material-ui/icons/WatchLater" :default WatchLater]
            ["@material-ui/icons/Waves" :default Waves]
            ["@material-ui/icons/WbAuto" :default WbAuto]
            ["@material-ui/icons/WbCloudy" :default WbCloudy]
            ["@material-ui/icons/WbIncandescent" :default WbIncandescent]
            ["@material-ui/icons/WbIridescent" :default WbIridescent]
            ["@material-ui/icons/WbSunny" :default WbSunny]
            ["@material-ui/icons/Wc" :default Wc]
            ["@material-ui/icons/Web" :default Web]
            ["@material-ui/icons/WebAsset" :default WebAsset]
            ["@material-ui/icons/Weekend" :default Weekend]
            ["@material-ui/icons/WhatsApp" :default WhatsApp]
            ["@material-ui/icons/Whatshot" :default Whatshot]
            ["@material-ui/icons/WhereToVote" :default WhereToVote]
            ["@material-ui/icons/Widgets" :default Widgets]
            ["@material-ui/icons/Wifi" :default Wifi]
            ["@material-ui/icons/WifiLock" :default WifiLock]
            ["@material-ui/icons/WifiOff" :default WifiOff]
            ["@material-ui/icons/WifiTethering" :default WifiTethering]
            ["@material-ui/icons/Work" :default Work]
            ["@material-ui/icons/WorkOff" :default WorkOff]
            ["@material-ui/icons/WorkOutline" :default WorkOutline]
            ["@material-ui/icons/WrapText" :default WrapText]
            ["@material-ui/icons/YouTube" :default YouTube]
            ["@material-ui/icons/YoutubeSearchedFor" :default YoutubeSearchedFor]
            ["@material-ui/icons/ZoomIn" :default ZoomIn]
            ["@material-ui/icons/ZoomOut" :default ZoomOut]
            ["@material-ui/icons/ZoomOutMap" :default ZoomOutMap]))

(def ac-unit (interop/react-factory AcUnit))
(def access-alarm (interop/react-factory AccessAlarm))
(def access-alarms (interop/react-factory AccessAlarms))
(def access-time (interop/react-factory AccessTime))
(def accessibility (interop/react-factory Accessibility))
(def accessibility-new (interop/react-factory AccessibilityNew))
(def accessible (interop/react-factory Accessible))
(def accessible-forward (interop/react-factory AccessibleForward))
(def account-balance (interop/react-factory AccountBalance))
(def account-balance-wallet (interop/react-factory AccountBalanceWallet))
(def account-box (interop/react-factory AccountBox))
(def account-circle (interop/react-factory AccountCircle))
(def account-tree (interop/react-factory AccountTree))
(def adb (interop/react-factory Adb))
(def add (interop/react-factory Add))
(def add-a-photo (interop/react-factory AddAPhoto))
(def add-alarm (interop/react-factory AddAlarm))
(def add-alert (interop/react-factory AddAlert))
(def add-box (interop/react-factory AddBox))
(def add-circle (interop/react-factory AddCircle))
(def add-circle-outline (interop/react-factory AddCircleOutline))
(def add-comment (interop/react-factory AddComment))
(def add-ic-call (interop/react-factory AddIcCall))
(def add-location (interop/react-factory AddLocation))
(def add-photo-alternate (interop/react-factory AddPhotoAlternate))
(def add-shopping-cart (interop/react-factory AddShoppingCart))
(def add-to-home-screen (interop/react-factory AddToHomeScreen))
(def add-to-photos (interop/react-factory AddToPhotos))
(def add-to-queue (interop/react-factory AddToQueue))
(def adjust (interop/react-factory Adjust))
(def airline-seat-flat (interop/react-factory AirlineSeatFlat))
(def airline-seat-flat-angled (interop/react-factory AirlineSeatFlatAngled))
(def airline-seat-individual-suite (interop/react-factory AirlineSeatIndividualSuite))
(def airline-seat-legroom-extra (interop/react-factory AirlineSeatLegroomExtra))
(def airline-seat-legroom-normal (interop/react-factory AirlineSeatLegroomNormal))
(def airline-seat-legroom-reduced (interop/react-factory AirlineSeatLegroomReduced))
(def airline-seat-recline-extra (interop/react-factory AirlineSeatReclineExtra))
(def airline-seat-recline-normal (interop/react-factory AirlineSeatReclineNormal))
(def airplanemode-active (interop/react-factory AirplanemodeActive))
(def airplanemode-inactive (interop/react-factory AirplanemodeInactive))
(def airplay (interop/react-factory Airplay))
(def airport-shuttle (interop/react-factory AirportShuttle))
(def alarm (interop/react-factory Alarm))
(def alarm-add (interop/react-factory AlarmAdd))
(def alarm-off (interop/react-factory AlarmOff))
(def alarm-on (interop/react-factory AlarmOn))
(def album (interop/react-factory Album))
(def all-inbox (interop/react-factory AllInbox))
(def all-inclusive (interop/react-factory AllInclusive))
(def all-out (interop/react-factory AllOut))
(def alternate-email (interop/react-factory AlternateEmail))
(def amp-stories (interop/react-factory AmpStories))
(def android (interop/react-factory Android))
(def announcement (interop/react-factory Announcement))
(def apartment (interop/react-factory Apartment))
(def apple (interop/react-factory Apple))
(def apps (interop/react-factory Apps))
(def archive (interop/react-factory Archive))
(def arrow-back (interop/react-factory ArrowBack))
(def arrow-back-ios (interop/react-factory ArrowBackIos))
(def arrow-downward (interop/react-factory ArrowDownward))
(def arrow-drop-down (interop/react-factory ArrowDropDown))
(def arrow-drop-down-circle (interop/react-factory ArrowDropDownCircle))
(def arrow-drop-up (interop/react-factory ArrowDropUp))
(def arrow-forward (interop/react-factory ArrowForward))
(def arrow-forward-ios (interop/react-factory ArrowForwardIos))
(def arrow-left (interop/react-factory ArrowLeft))
(def arrow-right (interop/react-factory ArrowRight))
(def arrow-right-alt (interop/react-factory ArrowRightAlt))
(def arrow-upward (interop/react-factory ArrowUpward))
(def art-track (interop/react-factory ArtTrack))
(def aspect-ratio (interop/react-factory AspectRatio))
(def assessment (interop/react-factory Assessment))
(def assignment (interop/react-factory Assignment))
(def assignment-ind (interop/react-factory AssignmentInd))
(def assignment-late (interop/react-factory AssignmentLate))
(def assignment-return (interop/react-factory AssignmentReturn))
(def assignment-returned (interop/react-factory AssignmentReturned))
(def assignment-turned-in (interop/react-factory AssignmentTurnedIn))
(def assistant (interop/react-factory Assistant))
(def assistant-photo (interop/react-factory AssistantPhoto))
(def atm (interop/react-factory Atm))
(def attach-file (interop/react-factory AttachFile))
(def attach-money (interop/react-factory AttachMoney))
(def attachment (interop/react-factory Attachment))
(def audiotrack (interop/react-factory Audiotrack))
(def autorenew (interop/react-factory Autorenew))
(def av-timer (interop/react-factory AvTimer))
(def backspace (interop/react-factory Backspace))
(def backup (interop/react-factory Backup))
(def ballot (interop/react-factory Ballot))
(def bar-chart (interop/react-factory BarChart))
(def bathtub (interop/react-factory Bathtub))
(def battery20 (interop/react-factory Battery20))
(def battery30 (interop/react-factory Battery30))
(def battery50 (interop/react-factory Battery50))
(def battery60 (interop/react-factory Battery60))
(def battery80 (interop/react-factory Battery80))
(def battery90 (interop/react-factory Battery90))
(def battery-alert (interop/react-factory BatteryAlert))
(def battery-charging20 (interop/react-factory BatteryCharging20))
(def battery-charging30 (interop/react-factory BatteryCharging30))
(def battery-charging50 (interop/react-factory BatteryCharging50))
(def battery-charging60 (interop/react-factory BatteryCharging60))
(def battery-charging80 (interop/react-factory BatteryCharging80))
(def battery-charging90 (interop/react-factory BatteryCharging90))
(def battery-charging-full (interop/react-factory BatteryChargingFull))
(def battery-full (interop/react-factory BatteryFull))
(def battery-std (interop/react-factory BatteryStd))
(def battery-unknown (interop/react-factory BatteryUnknown))
(def beach-access (interop/react-factory BeachAccess))
(def beenhere (interop/react-factory Beenhere))
(def block (interop/react-factory Block))
(def bluetooth (interop/react-factory Bluetooth))
(def bluetooth-audio (interop/react-factory BluetoothAudio))
(def bluetooth-connected (interop/react-factory BluetoothConnected))
(def bluetooth-disabled (interop/react-factory BluetoothDisabled))
(def bluetooth-searching (interop/react-factory BluetoothSearching))
(def blur-circular (interop/react-factory BlurCircular))
(def blur-linear (interop/react-factory BlurLinear))
(def blur-off (interop/react-factory BlurOff))
(def blur-on (interop/react-factory BlurOn))
(def book (interop/react-factory Book))
(def bookmark (interop/react-factory Bookmark))
(def bookmark-border (interop/react-factory BookmarkBorder))
(def bookmarks (interop/react-factory Bookmarks))
(def border-all (interop/react-factory BorderAll))
(def border-bottom (interop/react-factory BorderBottom))
(def border-clear (interop/react-factory BorderClear))
(def border-color (interop/react-factory BorderColor))
(def border-horizontal (interop/react-factory BorderHorizontal))
(def border-inner (interop/react-factory BorderInner))
(def border-left (interop/react-factory BorderLeft))
(def border-outer (interop/react-factory BorderOuter))
(def border-right (interop/react-factory BorderRight))
(def border-style (interop/react-factory BorderStyle))
(def border-top (interop/react-factory BorderTop))
(def border-vertical (interop/react-factory BorderVertical))
(def branding-watermark (interop/react-factory BrandingWatermark))
(def brightness1 (interop/react-factory Brightness1))
(def brightness2 (interop/react-factory Brightness2))
(def brightness3 (interop/react-factory Brightness3))
(def brightness4 (interop/react-factory Brightness4))
(def brightness5 (interop/react-factory Brightness5))
(def brightness6 (interop/react-factory Brightness6))
(def brightness7 (interop/react-factory Brightness7))
(def brightness-auto (interop/react-factory BrightnessAuto))
(def brightness-high (interop/react-factory BrightnessHigh))
(def brightness-low (interop/react-factory BrightnessLow))
(def brightness-medium (interop/react-factory BrightnessMedium))
(def broken-image (interop/react-factory BrokenImage))
(def brush (interop/react-factory Brush))
(def bubble-chart (interop/react-factory BubbleChart))
(def bug-report (interop/react-factory BugReport))
(def build (interop/react-factory Build))
(def burst-mode (interop/react-factory BurstMode))
(def business (interop/react-factory Business))
(def business-center (interop/react-factory BusinessCenter))
(def cached (interop/react-factory Cached))
(def cake (interop/react-factory Cake))
(def calendar-today (interop/react-factory CalendarToday))
(def calendar-view-day (interop/react-factory CalendarViewDay))
(def call (interop/react-factory Call))
(def call-end (interop/react-factory CallEnd))
(def call-made (interop/react-factory CallMade))
(def call-merge (interop/react-factory CallMerge))
(def call-missed (interop/react-factory CallMissed))
(def call-missed-outgoing (interop/react-factory CallMissedOutgoing))
(def call-received (interop/react-factory CallReceived))
(def call-split (interop/react-factory CallSplit))
(def call-to-action (interop/react-factory CallToAction))
(def camera (interop/react-factory Camera))
(def camera-alt (interop/react-factory CameraAlt))
(def camera-enhance (interop/react-factory CameraEnhance))
(def camera-front (interop/react-factory CameraFront))
(def camera-rear (interop/react-factory CameraRear))
(def camera-roll (interop/react-factory CameraRoll))
(def cancel (interop/react-factory Cancel))
(def cancel-presentation (interop/react-factory CancelPresentation))
(def cancel-schedule-send (interop/react-factory CancelScheduleSend))
(def card-giftcard (interop/react-factory CardGiftcard))
(def card-membership (interop/react-factory CardMembership))
(def card-travel (interop/react-factory CardTravel))
(def casino (interop/react-factory Casino))
(def cast (interop/react-factory Cast))
(def cast-connected (interop/react-factory CastConnected))
(def cast-for-education (interop/react-factory CastForEducation))
(def category (interop/react-factory Category))
(def cell-wifi (interop/react-factory CellWifi))
(def center-focus-strong (interop/react-factory CenterFocusStrong))
(def center-focus-weak (interop/react-factory CenterFocusWeak))
(def change-history (interop/react-factory ChangeHistory))
(def chat (interop/react-factory Chat))
(def chat-bubble (interop/react-factory ChatBubble))
(def chat-bubble-outline (interop/react-factory ChatBubbleOutline))
(def check (interop/react-factory Check))
(def check-box (interop/react-factory CheckBox))
(def check-box-outline-blank (interop/react-factory CheckBoxOutlineBlank))
(def check-circle (interop/react-factory CheckCircle))
(def check-circle-outline (interop/react-factory CheckCircleOutline))
(def chevron-left (interop/react-factory ChevronLeft))
(def chevron-right (interop/react-factory ChevronRight))
(def child-care (interop/react-factory ChildCare))
(def child-friendly (interop/react-factory ChildFriendly))
(def chrome-reader-mode (interop/react-factory ChromeReaderMode))
(def class (interop/react-factory Class))
(def clear (interop/react-factory Clear))
(def clear-all (interop/react-factory ClearAll))
(def close (interop/react-factory Close))
(def closed-caption (interop/react-factory ClosedCaption))
(def cloud (interop/react-factory Cloud))
(def cloud-circle (interop/react-factory CloudCircle))
(def cloud-done (interop/react-factory CloudDone))
(def cloud-download (interop/react-factory CloudDownload))
(def cloud-off (interop/react-factory CloudOff))
(def cloud-queue (interop/react-factory CloudQueue))
(def cloud-upload (interop/react-factory CloudUpload))
(def code (interop/react-factory Code))
(def collections (interop/react-factory Collections))
(def collections-bookmark (interop/react-factory CollectionsBookmark))
(def color-lens (interop/react-factory ColorLens))
(def colorize (interop/react-factory Colorize))
(def comment (interop/react-factory Comment))
(def commute (interop/react-factory Commute))
(def compare (interop/react-factory Compare))
(def compare-arrows (interop/react-factory CompareArrows))
(def compass-calibration (interop/react-factory CompassCalibration))
(def computer (interop/react-factory Computer))
(def confirmation-number (interop/react-factory ConfirmationNumber))
(def contact-mail (interop/react-factory ContactMail))
(def contact-phone (interop/react-factory ContactPhone))
(def contact-support (interop/react-factory ContactSupport))
(def contactless (interop/react-factory Contactless))
(def contacts (interop/react-factory Contacts))
(def control-camera (interop/react-factory ControlCamera))
(def control-point (interop/react-factory ControlPoint))
(def control-point-duplicate (interop/react-factory ControlPointDuplicate))
(def copyright (interop/react-factory Copyright))
(def create (interop/react-factory Create))
(def create-new-folder (interop/react-factory CreateNewFolder))
(def credit-card (interop/react-factory CreditCard))
(def crop (interop/react-factory Crop))
(def crop169 (interop/react-factory Crop169))
(def crop32 (interop/react-factory Crop32))
(def crop54 (interop/react-factory Crop54))
(def crop75 (interop/react-factory Crop75))
(def crop-din (interop/react-factory CropDin))
(def crop-free (interop/react-factory CropFree))
(def crop-landscape (interop/react-factory CropLandscape))
(def crop-original (interop/react-factory CropOriginal))
(def crop-portrait (interop/react-factory CropPortrait))
(def crop-rotate (interop/react-factory CropRotate))
(def crop-square (interop/react-factory CropSquare))
(def dashboard (interop/react-factory Dashboard))
(def data-usage (interop/react-factory DataUsage))
(def date-range (interop/react-factory DateRange))
(def deck (interop/react-factory Deck))
(def dehaze (interop/react-factory Dehaze))
(def delete (interop/react-factory Delete))
(def delete-forever (interop/react-factory DeleteForever))
(def delete-outline (interop/react-factory DeleteOutline))
(def delete-sweep (interop/react-factory DeleteSweep))
(def departure-board (interop/react-factory DepartureBoard))
(def description (interop/react-factory Description))
(def desktop-access-disabled (interop/react-factory DesktopAccessDisabled))
(def desktop-mac (interop/react-factory DesktopMac))
(def desktop-windows (interop/react-factory DesktopWindows))
(def details (interop/react-factory Details))
(def developer-board (interop/react-factory DeveloperBoard))
(def developer-mode (interop/react-factory DeveloperMode))
(def device-hub (interop/react-factory DeviceHub))
(def device-unknown (interop/react-factory DeviceUnknown))
(def devices (interop/react-factory Devices))
(def devices-other (interop/react-factory DevicesOther))
(def dialer-sip (interop/react-factory DialerSip))
(def dialpad (interop/react-factory Dialpad))
(def directions (interop/react-factory Directions))
(def directions-bike (interop/react-factory DirectionsBike))
(def directions-boat (interop/react-factory DirectionsBoat))
(def directions-bus (interop/react-factory DirectionsBus))
(def directions-car (interop/react-factory DirectionsCar))
(def directions-railway (interop/react-factory DirectionsRailway))
(def directions-run (interop/react-factory DirectionsRun))
(def directions-subway (interop/react-factory DirectionsSubway))
(def directions-transit (interop/react-factory DirectionsTransit))
(def directions-walk (interop/react-factory DirectionsWalk))
(def disc-full (interop/react-factory DiscFull))
(def dns (interop/react-factory Dns))
(def dock (interop/react-factory Dock))
(def domain (interop/react-factory Domain))
(def domain-disabled (interop/react-factory DomainDisabled))
(def done (interop/react-factory Done))
(def done-all (interop/react-factory DoneAll))
(def done-outline (interop/react-factory DoneOutline))
(def donut-large (interop/react-factory DonutLarge))
(def donut-small (interop/react-factory DonutSmall))
(def double-arrow (interop/react-factory DoubleArrow))
(def drafts (interop/react-factory Drafts))
(def drag-handle (interop/react-factory DragHandle))
(def drag-indicator (interop/react-factory DragIndicator))
(def drive-eta (interop/react-factory DriveEta))
(def duo (interop/react-factory Duo))
(def dvr (interop/react-factory Dvr))
(def dynamic-feed (interop/react-factory DynamicFeed))
(def eco (interop/react-factory Eco))
(def edit (interop/react-factory Edit))
(def edit-attributes (interop/react-factory EditAttributes))
(def edit-location (interop/react-factory EditLocation))
(def eject (interop/react-factory Eject))
(def email (interop/react-factory Email))
(def emoji-emotions (interop/react-factory EmojiEmotions))
(def emoji-events (interop/react-factory EmojiEvents))
(def emoji-flags (interop/react-factory EmojiFlags))
(def emoji-food-beverage (interop/react-factory EmojiFoodBeverage))
(def emoji-nature (interop/react-factory EmojiNature))
(def emoji-objects (interop/react-factory EmojiObjects))
(def emoji-people (interop/react-factory EmojiPeople))
(def emoji-symbols (interop/react-factory EmojiSymbols))
(def emoji-transportation (interop/react-factory EmojiTransportation))
(def enhanced-encryption (interop/react-factory EnhancedEncryption))
(def equalizer (interop/react-factory Equalizer))
(def error (interop/react-factory Error))
(def error-outline (interop/react-factory ErrorOutline))
(def euro (interop/react-factory Euro))
(def euro-symbol (interop/react-factory EuroSymbol))
(def ev-station (interop/react-factory EvStation))
(def event (interop/react-factory Event))
(def event-available (interop/react-factory EventAvailable))
(def event-busy (interop/react-factory EventBusy))
(def event-note (interop/react-factory EventNote))
(def event-seat (interop/react-factory EventSeat))
(def exit-to-app (interop/react-factory ExitToApp))
(def expand-less (interop/react-factory ExpandLess))
(def expand-more (interop/react-factory ExpandMore))
(def explicit (interop/react-factory Explicit))
(def explore (interop/react-factory Explore))
(def explore-off (interop/react-factory ExploreOff))
(def exposure (interop/react-factory Exposure))
(def exposure-neg1 (interop/react-factory ExposureNeg1))
(def exposure-neg2 (interop/react-factory ExposureNeg2))
(def exposure-plus1 (interop/react-factory ExposurePlus1))
(def exposure-plus2 (interop/react-factory ExposurePlus2))
(def exposure-zero (interop/react-factory ExposureZero))
(def extension (interop/react-factory Extension))
(def face (interop/react-factory Face))
(def facebook (interop/react-factory Facebook))
(def fast-forward (interop/react-factory FastForward))
(def fast-rewind (interop/react-factory FastRewind))
(def fastfood (interop/react-factory Fastfood))
(def favorite (interop/react-factory Favorite))
(def favorite-border (interop/react-factory FavoriteBorder))
(def featured-play-list (interop/react-factory FeaturedPlayList))
(def featured-video (interop/react-factory FeaturedVideo))
(def feedback (interop/react-factory Feedback))
(def fiber-dvr (interop/react-factory FiberDvr))
(def fiber-manual-record (interop/react-factory FiberManualRecord))
(def fiber-new (interop/react-factory FiberNew))
(def fiber-pin (interop/react-factory FiberPin))
(def fiber-smart-record (interop/react-factory FiberSmartRecord))
(def file-copy (interop/react-factory FileCopy))
(def filter (interop/react-factory Filter))
(def filter1 (interop/react-factory Filter1))
(def filter2 (interop/react-factory Filter2))
(def filter3 (interop/react-factory Filter3))
(def filter4 (interop/react-factory Filter4))
(def filter5 (interop/react-factory Filter5))
(def filter6 (interop/react-factory Filter6))
(def filter7 (interop/react-factory Filter7))
(def filter8 (interop/react-factory Filter8))
(def filter9 (interop/react-factory Filter9))
(def filter9-plus (interop/react-factory Filter9Plus))
(def filter-b-and-w (interop/react-factory FilterBAndW))
(def filter-center-focus (interop/react-factory FilterCenterFocus))
(def filter-drama (interop/react-factory FilterDrama))
(def filter-frames (interop/react-factory FilterFrames))
(def filter-hdr (interop/react-factory FilterHdr))
(def filter-list (interop/react-factory FilterList))
(def filter-none (interop/react-factory FilterNone))
(def filter-tilt-shift (interop/react-factory FilterTiltShift))
(def filter-vintage (interop/react-factory FilterVintage))
(def find-in-page (interop/react-factory FindInPage))
(def find-replace (interop/react-factory FindReplace))
(def fingerprint (interop/react-factory Fingerprint))
(def fireplace (interop/react-factory Fireplace))
(def first-page (interop/react-factory FirstPage))
(def fitness-center (interop/react-factory FitnessCenter))
(def flag (interop/react-factory Flag))
(def flare (interop/react-factory Flare))
(def flash-auto (interop/react-factory FlashAuto))
(def flash-off (interop/react-factory FlashOff))
(def flash-on (interop/react-factory FlashOn))
(def flight (interop/react-factory Flight))
(def flight-land (interop/react-factory FlightLand))
(def flight-takeoff (interop/react-factory FlightTakeoff))
(def flip (interop/react-factory Flip))
(def flip-camera-android (interop/react-factory FlipCameraAndroid))
(def flip-camera-ios (interop/react-factory FlipCameraIos))
(def flip-to-back (interop/react-factory FlipToBack))
(def flip-to-front (interop/react-factory FlipToFront))
(def folder (interop/react-factory Folder))
(def folder-open (interop/react-factory FolderOpen))
(def folder-shared (interop/react-factory FolderShared))
(def folder-special (interop/react-factory FolderSpecial))
(def font-download (interop/react-factory FontDownload))
(def format-align-center (interop/react-factory FormatAlignCenter))
(def format-align-justify (interop/react-factory FormatAlignJustify))
(def format-align-left (interop/react-factory FormatAlignLeft))
(def format-align-right (interop/react-factory FormatAlignRight))
(def format-bold (interop/react-factory FormatBold))
(def format-clear (interop/react-factory FormatClear))
(def format-color-fill (interop/react-factory FormatColorFill))
(def format-color-reset (interop/react-factory FormatColorReset))
(def format-color-text (interop/react-factory FormatColorText))
(def format-indent-decrease (interop/react-factory FormatIndentDecrease))
(def format-indent-increase (interop/react-factory FormatIndentIncrease))
(def format-italic (interop/react-factory FormatItalic))
(def format-line-spacing (interop/react-factory FormatLineSpacing))
(def format-list-bulleted (interop/react-factory FormatListBulleted))
(def format-list-numbered (interop/react-factory FormatListNumbered))
(def format-list-numbered-rtl (interop/react-factory FormatListNumberedRtl))
(def format-paint (interop/react-factory FormatPaint))
(def format-quote (interop/react-factory FormatQuote))
(def format-shapes (interop/react-factory FormatShapes))
(def format-size (interop/react-factory FormatSize))
(def format-strikethrough (interop/react-factory FormatStrikethrough))
(def format-textdirection-l-to-r (interop/react-factory FormatTextdirectionLToR))
(def format-textdirection-r-to-l (interop/react-factory FormatTextdirectionRToL))
(def format-underlined (interop/react-factory FormatUnderlined))
(def forum (interop/react-factory Forum))
(def forward (interop/react-factory Forward))
(def forward10 (interop/react-factory Forward10))
(def forward30 (interop/react-factory Forward30))
(def forward5 (interop/react-factory Forward5))
(def four-k (interop/react-factory FourK))
(def free-breakfast (interop/react-factory FreeBreakfast))
(def fullscreen (interop/react-factory Fullscreen))
(def fullscreen-exit (interop/react-factory FullscreenExit))
(def functions (interop/react-factory Functions))
(def g-translate (interop/react-factory GTranslate))
(def gamepad (interop/react-factory Gamepad))
(def games (interop/react-factory Games))
(def gavel (interop/react-factory Gavel))
(def gesture (interop/react-factory Gesture))
(def get-app (interop/react-factory GetApp))
(def gif (interop/react-factory Gif))
(def git-hub (interop/react-factory GitHub))
(def golf-course (interop/react-factory GolfCourse))
(def gps-fixed (interop/react-factory GpsFixed))
(def gps-not-fixed (interop/react-factory GpsNotFixed))
(def gps-off (interop/react-factory GpsOff))
(def grade (interop/react-factory Grade))
(def gradient (interop/react-factory Gradient))
(def grain (interop/react-factory Grain))
(def graphic-eq (interop/react-factory GraphicEq))
(def grid-off (interop/react-factory GridOff))
(def grid-on (interop/react-factory GridOn))
(def group (interop/react-factory Group))
(def group-add (interop/react-factory GroupAdd))
(def group-work (interop/react-factory GroupWork))
(def hd (interop/react-factory Hd))
(def hdr-off (interop/react-factory HdrOff))
(def hdr-on (interop/react-factory HdrOn))
(def hdr-strong (interop/react-factory HdrStrong))
(def hdr-weak (interop/react-factory HdrWeak))
(def headset (interop/react-factory Headset))
(def headset-mic (interop/react-factory HeadsetMic))
(def healing (interop/react-factory Healing))
(def hearing (interop/react-factory Hearing))
(def height (interop/react-factory Height))
(def help (interop/react-factory Help))
(def help-outline (interop/react-factory HelpOutline))
(def high-quality (interop/react-factory HighQuality))
(def highlight (interop/react-factory Highlight))
(def highlight-off (interop/react-factory HighlightOff))
(def history (interop/react-factory History))
(def home (interop/react-factory Home))
(def home-work (interop/react-factory HomeWork))
(def horizontal-split (interop/react-factory HorizontalSplit))
(def hot-tub (interop/react-factory HotTub))
(def hotel (interop/react-factory Hotel))
(def hourglass-empty (interop/react-factory HourglassEmpty))
(def hourglass-full (interop/react-factory HourglassFull))
(def house (interop/react-factory House))
(def how-to-reg (interop/react-factory HowToReg))
(def how-to-vote (interop/react-factory HowToVote))
(def http (interop/react-factory Http))
(def https (interop/react-factory Https))
(def image (interop/react-factory Image))
(def image-aspect-ratio (interop/react-factory ImageAspectRatio))
(def image-search (interop/react-factory ImageSearch))
(def import-contacts (interop/react-factory ImportContacts))
(def import-export (interop/react-factory ImportExport))
(def important-devices (interop/react-factory ImportantDevices))
(def inbox (interop/react-factory Inbox))
(def indeterminate-check-box (interop/react-factory IndeterminateCheckBox))
(def info (interop/react-factory Info))
(def input (interop/react-factory Input))
(def insert-chart (interop/react-factory InsertChart))
(def insert-comment (interop/react-factory InsertComment))
(def insert-drive-file (interop/react-factory InsertDriveFile))
(def insert-emoticon (interop/react-factory InsertEmoticon))
(def insert-invitation (interop/react-factory InsertInvitation))
(def insert-link (interop/react-factory InsertLink))
(def insert-photo (interop/react-factory InsertPhoto))
(def instagram (interop/react-factory Instagram))
(def invert-colors (interop/react-factory InvertColors))
(def invert-colors-off (interop/react-factory InvertColorsOff))
(def iso (interop/react-factory Iso))
(def keyboard (interop/react-factory Keyboard))
(def keyboard-arrow-down (interop/react-factory KeyboardArrowDown))
(def keyboard-arrow-left (interop/react-factory KeyboardArrowLeft))
(def keyboard-arrow-right (interop/react-factory KeyboardArrowRight))
(def keyboard-arrow-up (interop/react-factory KeyboardArrowUp))
(def keyboard-backspace (interop/react-factory KeyboardBackspace))
(def keyboard-capslock (interop/react-factory KeyboardCapslock))
(def keyboard-hide (interop/react-factory KeyboardHide))
(def keyboard-return (interop/react-factory KeyboardReturn))
(def keyboard-tab (interop/react-factory KeyboardTab))
(def keyboard-voice (interop/react-factory KeyboardVoice))
(def king-bed (interop/react-factory KingBed))
(def kitchen (interop/react-factory Kitchen))
(def label (interop/react-factory Label))
(def label-important (interop/react-factory LabelImportant))
(def label-off (interop/react-factory LabelOff))
(def landscape (interop/react-factory Landscape))
(def language (interop/react-factory Language))
(def laptop (interop/react-factory Laptop))
(def laptop-chromebook (interop/react-factory LaptopChromebook))
(def laptop-mac (interop/react-factory LaptopMac))
(def laptop-windows (interop/react-factory LaptopWindows))
(def last-page (interop/react-factory LastPage))
(def launch (interop/react-factory Launch))
(def layers (interop/react-factory Layers))
(def layers-clear (interop/react-factory LayersClear))
(def leak-add (interop/react-factory LeakAdd))
(def leak-remove (interop/react-factory LeakRemove))
(def lens (interop/react-factory Lens))
(def library-add (interop/react-factory LibraryAdd))
(def library-add-check (interop/react-factory LibraryAddCheck))
(def library-books (interop/react-factory LibraryBooks))
(def library-music (interop/react-factory LibraryMusic))
(def line-style (interop/react-factory LineStyle))
(def line-weight (interop/react-factory LineWeight))
(def linear-scale (interop/react-factory LinearScale))
(def link (interop/react-factory Link))
(def link-off (interop/react-factory LinkOff))
(def linked-camera (interop/react-factory LinkedCamera))
(def linked-in (interop/react-factory LinkedIn))
(def list (interop/react-factory List))
(def list-alt (interop/react-factory ListAlt))
(def live-help (interop/react-factory LiveHelp))
(def live-tv (interop/react-factory LiveTv))
(def local-activity (interop/react-factory LocalActivity))
(def local-airport (interop/react-factory LocalAirport))
(def local-atm (interop/react-factory LocalAtm))
(def local-bar (interop/react-factory LocalBar))
(def local-cafe (interop/react-factory LocalCafe))
(def local-car-wash (interop/react-factory LocalCarWash))
(def local-convenience-store (interop/react-factory LocalConvenienceStore))
(def local-dining (interop/react-factory LocalDining))
(def local-drink (interop/react-factory LocalDrink))
(def local-florist (interop/react-factory LocalFlorist))
(def local-gas-station (interop/react-factory LocalGasStation))
(def local-grocery-store (interop/react-factory LocalGroceryStore))
(def local-hospital (interop/react-factory LocalHospital))
(def local-hotel (interop/react-factory LocalHotel))
(def local-laundry-service (interop/react-factory LocalLaundryService))
(def local-library (interop/react-factory LocalLibrary))
(def local-mall (interop/react-factory LocalMall))
(def local-movies (interop/react-factory LocalMovies))
(def local-offer (interop/react-factory LocalOffer))
(def local-parking (interop/react-factory LocalParking))
(def local-pharmacy (interop/react-factory LocalPharmacy))
(def local-phone (interop/react-factory LocalPhone))
(def local-pizza (interop/react-factory LocalPizza))
(def local-play (interop/react-factory LocalPlay))
(def local-post-office (interop/react-factory LocalPostOffice))
(def local-printshop (interop/react-factory LocalPrintshop))
(def local-see (interop/react-factory LocalSee))
(def local-shipping (interop/react-factory LocalShipping))
(def local-taxi (interop/react-factory LocalTaxi))
(def location-city (interop/react-factory LocationCity))
(def location-disabled (interop/react-factory LocationDisabled))
(def location-off (interop/react-factory LocationOff))
(def location-on (interop/react-factory LocationOn))
(def location-searching (interop/react-factory LocationSearching))
(def lock (interop/react-factory Lock))
(def lock-open (interop/react-factory LockOpen))
(def looks (interop/react-factory Looks))
(def looks3 (interop/react-factory Looks3))
(def looks4 (interop/react-factory Looks4))
(def looks5 (interop/react-factory Looks5))
(def looks6 (interop/react-factory Looks6))
(def looks-one (interop/react-factory LooksOne))
(def looks-two (interop/react-factory LooksTwo))
(def loop (interop/react-factory Loop))
(def loupe (interop/react-factory Loupe))
(def low-priority (interop/react-factory LowPriority))
(def loyalty (interop/react-factory Loyalty))
(def mail (interop/react-factory Mail))
(def mail-outline (interop/react-factory MailOutline))
(def map (interop/react-factory Map))
(def markunread (interop/react-factory Markunread))
(def markunread-mailbox (interop/react-factory MarkunreadMailbox))
(def maximize (interop/react-factory Maximize))
(def meeting-room (interop/react-factory MeetingRoom))
(def memory (interop/react-factory Memory))
(def menu (interop/react-factory Menu))
(def menu-book (interop/react-factory MenuBook))
(def menu-open (interop/react-factory MenuOpen))
(def merge-type (interop/react-factory MergeType))
(def message (interop/react-factory Message))
(def mic (interop/react-factory Mic))
(def mic-none (interop/react-factory MicNone))
(def mic-off (interop/react-factory MicOff))
(def minimize (interop/react-factory Minimize))
(def missed-video-call (interop/react-factory MissedVideoCall))
(def mms (interop/react-factory Mms))
(def mobile-friendly (interop/react-factory MobileFriendly))
(def mobile-off (interop/react-factory MobileOff))
(def mobile-screen-share (interop/react-factory MobileScreenShare))
(def mode-comment (interop/react-factory ModeComment))
(def monetization-on (interop/react-factory MonetizationOn))
(def money (interop/react-factory Money))
(def money-off (interop/react-factory MoneyOff))
(def monochrome-photos (interop/react-factory MonochromePhotos))
(def mood (interop/react-factory Mood))
(def mood-bad (interop/react-factory MoodBad))
(def more (interop/react-factory More))
(def more-horiz (interop/react-factory MoreHoriz))
(def more-vert (interop/react-factory MoreVert))
(def motorcycle (interop/react-factory Motorcycle))
(def mouse (interop/react-factory Mouse))
(def move-to-inbox (interop/react-factory MoveToInbox))
(def movie (interop/react-factory Movie))
(def movie-creation (interop/react-factory MovieCreation))
(def movie-filter (interop/react-factory MovieFilter))
(def multiline-chart (interop/react-factory MultilineChart))
(def museum (interop/react-factory Museum))
(def music-note (interop/react-factory MusicNote))
(def music-off (interop/react-factory MusicOff))
(def music-video (interop/react-factory MusicVideo))
(def my-location (interop/react-factory MyLocation))
(def nature (interop/react-factory Nature))
(def nature-people (interop/react-factory NaturePeople))
(def navigate-before (interop/react-factory NavigateBefore))
(def navigate-next (interop/react-factory NavigateNext))
(def navigation (interop/react-factory Navigation))
(def near-me (interop/react-factory NearMe))
(def network-cell (interop/react-factory NetworkCell))
(def network-check (interop/react-factory NetworkCheck))
(def network-locked (interop/react-factory NetworkLocked))
(def network-wifi (interop/react-factory NetworkWifi))
(def new-releases (interop/react-factory NewReleases))
(def next-week (interop/react-factory NextWeek))
(def nfc (interop/react-factory Nfc))
(def nights-stay (interop/react-factory NightsStay))
(def no-encryption (interop/react-factory NoEncryption))
(def no-meeting-room (interop/react-factory NoMeetingRoom))
(def no-sim (interop/react-factory NoSim))
(def not-interested (interop/react-factory NotInterested))
(def not-listed-location (interop/react-factory NotListedLocation))
(def note (interop/react-factory Note))
(def note-add (interop/react-factory NoteAdd))
(def notes (interop/react-factory Notes))
(def notification-important (interop/react-factory NotificationImportant))
(def notifications (interop/react-factory Notifications))
(def notifications-active (interop/react-factory NotificationsActive))
(def notifications-none (interop/react-factory NotificationsNone))
(def notifications-off (interop/react-factory NotificationsOff))
(def notifications-paused (interop/react-factory NotificationsPaused))
(def offline-bolt (interop/react-factory OfflineBolt))
(def offline-pin (interop/react-factory OfflinePin))
(def ondemand-video (interop/react-factory OndemandVideo))
(def opacity (interop/react-factory Opacity))
(def open-in-browser (interop/react-factory OpenInBrowser))
(def open-in-new (interop/react-factory OpenInNew))
(def open-with (interop/react-factory OpenWith))
(def outdoor-grill (interop/react-factory OutdoorGrill))
(def pages (interop/react-factory Pages))
(def pageview (interop/react-factory Pageview))
(def palette (interop/react-factory Palette))
(def pan-tool (interop/react-factory PanTool))
(def panorama (interop/react-factory Panorama))
(def panorama-fish-eye (interop/react-factory PanoramaFishEye))
(def panorama-horizontal (interop/react-factory PanoramaHorizontal))
(def panorama-vertical (interop/react-factory PanoramaVertical))
(def panorama-wide-angle (interop/react-factory PanoramaWideAngle))
(def party-mode (interop/react-factory PartyMode))
(def pause (interop/react-factory Pause))
(def pause-circle-filled (interop/react-factory PauseCircleFilled))
(def pause-circle-outline (interop/react-factory PauseCircleOutline))
(def pause-presentation (interop/react-factory PausePresentation))
(def payment (interop/react-factory Payment))
(def people (interop/react-factory People))
(def people-alt (interop/react-factory PeopleAlt))
(def people-outline (interop/react-factory PeopleOutline))
(def perm-camera-mic (interop/react-factory PermCameraMic))
(def perm-contact-calendar (interop/react-factory PermContactCalendar))
(def perm-data-setting (interop/react-factory PermDataSetting))
(def perm-device-information (interop/react-factory PermDeviceInformation))
(def perm-identity (interop/react-factory PermIdentity))
(def perm-media (interop/react-factory PermMedia))
(def perm-phone-msg (interop/react-factory PermPhoneMsg))
(def perm-scan-wifi (interop/react-factory PermScanWifi))
(def person (interop/react-factory Person))
(def person-add (interop/react-factory PersonAdd))
(def person-add-disabled (interop/react-factory PersonAddDisabled))
(def person-outline (interop/react-factory PersonOutline))
(def person-pin (interop/react-factory PersonPin))
(def person-pin-circle (interop/react-factory PersonPinCircle))
(def personal-video (interop/react-factory PersonalVideo))
(def pets (interop/react-factory Pets))
(def phone (interop/react-factory Phone))
(def phone-android (interop/react-factory PhoneAndroid))
(def phone-bluetooth-speaker (interop/react-factory PhoneBluetoothSpeaker))
(def phone-callback (interop/react-factory PhoneCallback))
(def phone-disabled (interop/react-factory PhoneDisabled))
(def phone-enabled (interop/react-factory PhoneEnabled))
(def phone-forwarded (interop/react-factory PhoneForwarded))
(def phone-in-talk (interop/react-factory PhoneInTalk))
(def phone-iphone (interop/react-factory PhoneIphone))
(def phone-locked (interop/react-factory PhoneLocked))
(def phone-missed (interop/react-factory PhoneMissed))
(def phone-paused (interop/react-factory PhonePaused))
(def phonelink (interop/react-factory Phonelink))
(def phonelink-erase (interop/react-factory PhonelinkErase))
(def phonelink-lock (interop/react-factory PhonelinkLock))
(def phonelink-off (interop/react-factory PhonelinkOff))
(def phonelink-ring (interop/react-factory PhonelinkRing))
(def phonelink-setup (interop/react-factory PhonelinkSetup))
(def photo (interop/react-factory Photo))
(def photo-album (interop/react-factory PhotoAlbum))
(def photo-camera (interop/react-factory PhotoCamera))
(def photo-filter (interop/react-factory PhotoFilter))
(def photo-library (interop/react-factory PhotoLibrary))
(def photo-size-select-actual (interop/react-factory PhotoSizeSelectActual))
(def photo-size-select-large (interop/react-factory PhotoSizeSelectLarge))
(def photo-size-select-small (interop/react-factory PhotoSizeSelectSmall))
(def picture-as-pdf (interop/react-factory PictureAsPdf))
(def picture-in-picture (interop/react-factory PictureInPicture))
(def picture-in-picture-alt (interop/react-factory PictureInPictureAlt))
(def pie-chart (interop/react-factory PieChart))
(def pin-drop (interop/react-factory PinDrop))
(def pinterest (interop/react-factory Pinterest))
(def place (interop/react-factory Place))
(def play-arrow (interop/react-factory PlayArrow))
(def play-circle-filled (interop/react-factory PlayCircleFilled))
(def play-circle-filled-white (interop/react-factory PlayCircleFilledWhite))
(def play-circle-outline (interop/react-factory PlayCircleOutline))
(def play-for-work (interop/react-factory PlayForWork))
(def playlist-add (interop/react-factory PlaylistAdd))
(def playlist-add-check (interop/react-factory PlaylistAddCheck))
(def playlist-play (interop/react-factory PlaylistPlay))
(def plus-one (interop/react-factory PlusOne))
(def policy (interop/react-factory Policy))
(def poll (interop/react-factory Poll))
(def polymer (interop/react-factory Polymer))
(def pool (interop/react-factory Pool))
(def portable-wifi-off (interop/react-factory PortableWifiOff))
(def portrait (interop/react-factory Portrait))
(def post-add (interop/react-factory PostAdd))
(def power (interop/react-factory Power))
(def power-input (interop/react-factory PowerInput))
(def power-off (interop/react-factory PowerOff))
(def power-settings-new (interop/react-factory PowerSettingsNew))
(def pregnant-woman (interop/react-factory PregnantWoman))
(def present-to-all (interop/react-factory PresentToAll))
(def print (interop/react-factory Print))
(def print-disabled (interop/react-factory PrintDisabled))
(def priority-high (interop/react-factory PriorityHigh))
(def public (interop/react-factory Public))
(def publish (interop/react-factory Publish))
(def query-builder (interop/react-factory QueryBuilder))
(def question-answer (interop/react-factory QuestionAnswer))
(def queue (interop/react-factory Queue))
(def queue-music (interop/react-factory QueueMusic))
(def queue-play-next (interop/react-factory QueuePlayNext))
(def radio (interop/react-factory Radio))
(def radio-button-checked (interop/react-factory RadioButtonChecked))
(def radio-button-unchecked (interop/react-factory RadioButtonUnchecked))
(def rate-review (interop/react-factory RateReview))
(def receipt (interop/react-factory Receipt))
(def recent-actors (interop/react-factory RecentActors))
(def record-voice-over (interop/react-factory RecordVoiceOver))
(def reddit (interop/react-factory Reddit))
(def redeem (interop/react-factory Redeem))
(def redo (interop/react-factory Redo))
(def refresh (interop/react-factory Refresh))
(def remove (interop/react-factory Remove))
(def remove-circle (interop/react-factory RemoveCircle))
(def remove-circle-outline (interop/react-factory RemoveCircleOutline))
(def remove-from-queue (interop/react-factory RemoveFromQueue))
(def remove-red-eye (interop/react-factory RemoveRedEye))
(def remove-shopping-cart (interop/react-factory RemoveShoppingCart))
(def reorder (interop/react-factory Reorder))
(def repeat (interop/react-factory Repeat))
(def repeat-one (interop/react-factory RepeatOne))
(def replay (interop/react-factory Replay))
(def replay10 (interop/react-factory Replay10))
(def replay30 (interop/react-factory Replay30))
(def replay5 (interop/react-factory Replay5))
(def reply (interop/react-factory Reply))
(def reply-all (interop/react-factory ReplyAll))
(def report (interop/react-factory Report))
(def report-off (interop/react-factory ReportOff))
(def report-problem (interop/react-factory ReportProblem))
(def restaurant (interop/react-factory Restaurant))
(def restaurant-menu (interop/react-factory RestaurantMenu))
(def restore (interop/react-factory Restore))
(def restore-from-trash (interop/react-factory RestoreFromTrash))
(def restore-page (interop/react-factory RestorePage))
(def ring-volume (interop/react-factory RingVolume))
(def room (interop/react-factory Room))
(def room-service (interop/react-factory RoomService))
(def rotate90-degrees-ccw (interop/react-factory Rotate90DegreesCcw))
(def rotate-left (interop/react-factory RotateLeft))
(def rotate-right (interop/react-factory RotateRight))
(def router (interop/react-factory Router))
(def rowing (interop/react-factory Rowing))
(def rss-feed (interop/react-factory RssFeed))
(def rv-hookup (interop/react-factory RvHookup))
(def satellite (interop/react-factory Satellite))
(def save (interop/react-factory Save))
(def save-alt (interop/react-factory SaveAlt))
(def scanner (interop/react-factory Scanner))
(def scatter-plot (interop/react-factory ScatterPlot))
(def schedule (interop/react-factory Schedule))
(def school (interop/react-factory School))
(def score (interop/react-factory Score))
(def screen-lock-landscape (interop/react-factory ScreenLockLandscape))
(def screen-lock-portrait (interop/react-factory ScreenLockPortrait))
(def screen-lock-rotation (interop/react-factory ScreenLockRotation))
(def screen-rotation (interop/react-factory ScreenRotation))
(def screen-share (interop/react-factory ScreenShare))
(def sd-card (interop/react-factory SdCard))
(def sd-storage (interop/react-factory SdStorage))
(def search (interop/react-factory Search))
(def security (interop/react-factory Security))
(def select-all (interop/react-factory SelectAll))
(def send (interop/react-factory Send))
(def sentiment-dissatisfied (interop/react-factory SentimentDissatisfied))
(def sentiment-satisfied (interop/react-factory SentimentSatisfied))
(def sentiment-satisfied-alt (interop/react-factory SentimentSatisfiedAlt))
(def sentiment-very-dissatisfied (interop/react-factory SentimentVeryDissatisfied))
(def sentiment-very-satisfied (interop/react-factory SentimentVerySatisfied))
(def settings (interop/react-factory Settings))
(def settings-applications (interop/react-factory SettingsApplications))
(def settings-backup-restore (interop/react-factory SettingsBackupRestore))
(def settings-bluetooth (interop/react-factory SettingsBluetooth))
(def settings-brightness (interop/react-factory SettingsBrightness))
(def settings-cell (interop/react-factory SettingsCell))
(def settings-ethernet (interop/react-factory SettingsEthernet))
(def settings-input-antenna (interop/react-factory SettingsInputAntenna))
(def settings-input-component (interop/react-factory SettingsInputComponent))
(def settings-input-composite (interop/react-factory SettingsInputComposite))
(def settings-input-hdmi (interop/react-factory SettingsInputHdmi))
(def settings-input-svideo (interop/react-factory SettingsInputSvideo))
(def settings-overscan (interop/react-factory SettingsOverscan))
(def settings-phone (interop/react-factory SettingsPhone))
(def settings-power (interop/react-factory SettingsPower))
(def settings-remote (interop/react-factory SettingsRemote))
(def settings-system-daydream (interop/react-factory SettingsSystemDaydream))
(def settings-voice (interop/react-factory SettingsVoice))
(def share (interop/react-factory Share))
(def shop (interop/react-factory Shop))
(def shop-two (interop/react-factory ShopTwo))
(def shopping-basket (interop/react-factory ShoppingBasket))
(def shopping-cart (interop/react-factory ShoppingCart))
(def short-text (interop/react-factory ShortText))
(def show-chart (interop/react-factory ShowChart))
(def shuffle (interop/react-factory Shuffle))
(def shutter-speed (interop/react-factory ShutterSpeed))
(def signal-cellular0-bar (interop/react-factory SignalCellular0Bar))
(def signal-cellular1-bar (interop/react-factory SignalCellular1Bar))
(def signal-cellular2-bar (interop/react-factory SignalCellular2Bar))
(def signal-cellular3-bar (interop/react-factory SignalCellular3Bar))
(def signal-cellular4-bar (interop/react-factory SignalCellular4Bar))
(def signal-cellular-alt (interop/react-factory SignalCellularAlt))
(def signal-cellular-connected-no-internet0-bar (interop/react-factory SignalCellularConnectedNoInternet0Bar))
(def signal-cellular-connected-no-internet1-bar (interop/react-factory SignalCellularConnectedNoInternet1Bar))
(def signal-cellular-connected-no-internet2-bar (interop/react-factory SignalCellularConnectedNoInternet2Bar))
(def signal-cellular-connected-no-internet3-bar (interop/react-factory SignalCellularConnectedNoInternet3Bar))
(def signal-cellular-connected-no-internet4-bar (interop/react-factory SignalCellularConnectedNoInternet4Bar))
(def signal-cellular-no-sim (interop/react-factory SignalCellularNoSim))
(def signal-cellular-null (interop/react-factory SignalCellularNull))
(def signal-cellular-off (interop/react-factory SignalCellularOff))
(def signal-wifi0-bar (interop/react-factory SignalWifi0Bar))
(def signal-wifi1-bar (interop/react-factory SignalWifi1Bar))
(def signal-wifi1-bar-lock (interop/react-factory SignalWifi1BarLock))
(def signal-wifi2-bar (interop/react-factory SignalWifi2Bar))
(def signal-wifi2-bar-lock (interop/react-factory SignalWifi2BarLock))
(def signal-wifi3-bar (interop/react-factory SignalWifi3Bar))
(def signal-wifi3-bar-lock (interop/react-factory SignalWifi3BarLock))
(def signal-wifi4-bar (interop/react-factory SignalWifi4Bar))
(def signal-wifi4-bar-lock (interop/react-factory SignalWifi4BarLock))
(def signal-wifi-off (interop/react-factory SignalWifiOff))
(def sim-card (interop/react-factory SimCard))
(def single-bed (interop/react-factory SingleBed))
(def skip-next (interop/react-factory SkipNext))
(def skip-previous (interop/react-factory SkipPrevious))
(def slideshow (interop/react-factory Slideshow))
(def slow-motion-video (interop/react-factory SlowMotionVideo))
(def smartphone (interop/react-factory Smartphone))
(def smoke-free (interop/react-factory SmokeFree))
(def smoking-rooms (interop/react-factory SmokingRooms))
(def sms (interop/react-factory Sms))
(def sms-failed (interop/react-factory SmsFailed))
(def snooze (interop/react-factory Snooze))
(def sort (interop/react-factory Sort))
(def sort-by-alpha (interop/react-factory SortByAlpha))
(def spa (interop/react-factory Spa))
(def space-bar (interop/react-factory SpaceBar))
(def speaker (interop/react-factory Speaker))
(def speaker-group (interop/react-factory SpeakerGroup))
(def speaker-notes (interop/react-factory SpeakerNotes))
(def speaker-notes-off (interop/react-factory SpeakerNotesOff))
(def speaker-phone (interop/react-factory SpeakerPhone))
(def speed (interop/react-factory Speed))
(def spellcheck (interop/react-factory Spellcheck))
(def sports (interop/react-factory Sports))
(def sports-baseball (interop/react-factory SportsBaseball))
(def sports-basketball (interop/react-factory SportsBasketball))
(def sports-cricket (interop/react-factory SportsCricket))
(def sports-esports (interop/react-factory SportsEsports))
(def sports-football (interop/react-factory SportsFootball))
(def sports-golf (interop/react-factory SportsGolf))
(def sports-handball (interop/react-factory SportsHandball))
(def sports-hockey (interop/react-factory SportsHockey))
(def sports-kabaddi (interop/react-factory SportsKabaddi))
(def sports-mma (interop/react-factory SportsMma))
(def sports-motorsports (interop/react-factory SportsMotorsports))
(def sports-rugby (interop/react-factory SportsRugby))
(def sports-soccer (interop/react-factory SportsSoccer))
(def sports-tennis (interop/react-factory SportsTennis))
(def sports-volleyball (interop/react-factory SportsVolleyball))
(def square-foot (interop/react-factory SquareFoot))
(def star (interop/react-factory Star))
(def star-border (interop/react-factory StarBorder))
(def star-half (interop/react-factory StarHalf))
(def star-rate (interop/react-factory StarRate))
(def stars (interop/react-factory Stars))
(def stay-current-landscape (interop/react-factory StayCurrentLandscape))
(def stay-current-portrait (interop/react-factory StayCurrentPortrait))
(def stay-primary-landscape (interop/react-factory StayPrimaryLandscape))
(def stay-primary-portrait (interop/react-factory StayPrimaryPortrait))
(def stop (interop/react-factory Stop))
(def stop-screen-share (interop/react-factory StopScreenShare))
(def storage (interop/react-factory Storage))
(def store (interop/react-factory Store))
(def store-mall-directory (interop/react-factory StoreMallDirectory))
(def storefront (interop/react-factory Storefront))
(def straighten (interop/react-factory Straighten))
(def streetview (interop/react-factory Streetview))
(def strikethrough-s (interop/react-factory StrikethroughS))
(def style (interop/react-factory Style))
(def subdirectory-arrow-left (interop/react-factory SubdirectoryArrowLeft))
(def subdirectory-arrow-right (interop/react-factory SubdirectoryArrowRight))
(def subject (interop/react-factory Subject))
(def subscriptions (interop/react-factory Subscriptions))
(def subtitles (interop/react-factory Subtitles))
(def subway (interop/react-factory Subway))
(def supervised-user-circle (interop/react-factory SupervisedUserCircle))
(def supervisor-account (interop/react-factory SupervisorAccount))
(def surround-sound (interop/react-factory SurroundSound))
(def swap-calls (interop/react-factory SwapCalls))
(def swap-horiz (interop/react-factory SwapHoriz))
(def swap-horizontal-circle (interop/react-factory SwapHorizontalCircle))
(def swap-vert (interop/react-factory SwapVert))
(def swap-vertical-circle (interop/react-factory SwapVerticalCircle))
(def switch-camera (interop/react-factory SwitchCamera))
(def switch-video (interop/react-factory SwitchVideo))
(def sync (interop/react-factory Sync))
(def sync-alt (interop/react-factory SyncAlt))
(def sync-disabled (interop/react-factory SyncDisabled))
(def sync-problem (interop/react-factory SyncProblem))
(def system-update (interop/react-factory SystemUpdate))
(def system-update-alt (interop/react-factory SystemUpdateAlt))
(def tab (interop/react-factory Tab))
(def tab-unselected (interop/react-factory TabUnselected))
(def table-chart (interop/react-factory TableChart))
(def tablet (interop/react-factory Tablet))
(def tablet-android (interop/react-factory TabletAndroid))
(def tablet-mac (interop/react-factory TabletMac))
(def tag-faces (interop/react-factory TagFaces))
(def tap-and-play (interop/react-factory TapAndPlay))
(def telegram (interop/react-factory Telegram))
(def terrain (interop/react-factory Terrain))
(def text-fields (interop/react-factory TextFields))
(def text-format (interop/react-factory TextFormat))
(def text-rotate-up (interop/react-factory TextRotateUp))
(def text-rotate-vertical (interop/react-factory TextRotateVertical))
(def text-rotation-angledown (interop/react-factory TextRotationAngledown))
(def text-rotation-angleup (interop/react-factory TextRotationAngleup))
(def text-rotation-down (interop/react-factory TextRotationDown))
(def text-rotation-none (interop/react-factory TextRotationNone))
(def textsms (interop/react-factory Textsms))
(def texture (interop/react-factory Texture))
(def theaters (interop/react-factory Theaters))
(def three-d-rotation (interop/react-factory ThreeDRotation))
(def three-sixty (interop/react-factory ThreeSixty))
(def thumb-down (interop/react-factory ThumbDown))
(def thumb-down-alt (interop/react-factory ThumbDownAlt))
(def thumb-up (interop/react-factory ThumbUp))
(def thumb-up-alt (interop/react-factory ThumbUpAlt))
(def thumbs-up-down (interop/react-factory ThumbsUpDown))
(def time-to-leave (interop/react-factory TimeToLeave))
(def timelapse (interop/react-factory Timelapse))
(def timeline (interop/react-factory Timeline))
(def timer (interop/react-factory Timer))
(def timer10 (interop/react-factory Timer10))
(def timer3 (interop/react-factory Timer3))
(def timer-off (interop/react-factory TimerOff))
(def title (interop/react-factory Title))
(def toc (interop/react-factory Toc))
(def today (interop/react-factory Today))
(def toggle-off (interop/react-factory ToggleOff))
(def toggle-on (interop/react-factory ToggleOn))
(def toll (interop/react-factory Toll))
(def tonality (interop/react-factory Tonality))
(def touch-app (interop/react-factory TouchApp))
(def toys (interop/react-factory Toys))
(def track-changes (interop/react-factory TrackChanges))
(def traffic (interop/react-factory Traffic))
(def train (interop/react-factory Train))
(def tram (interop/react-factory Tram))
(def transfer-within-a-station (interop/react-factory TransferWithinAStation))
(def transform (interop/react-factory Transform))
(def transit-enterexit (interop/react-factory TransitEnterexit))
(def translate (interop/react-factory Translate))
(def trending-down (interop/react-factory TrendingDown))
(def trending-flat (interop/react-factory TrendingFlat))
(def trending-up (interop/react-factory TrendingUp))
(def trip-origin (interop/react-factory TripOrigin))
(def tune (interop/react-factory Tune))
(def turned-in (interop/react-factory TurnedIn))
(def turned-in-not (interop/react-factory TurnedInNot))
(def tv (interop/react-factory Tv))
(def tv-off (interop/react-factory TvOff))
(def twitter (interop/react-factory Twitter))
(def unarchive (interop/react-factory Unarchive))
(def undo (interop/react-factory Undo))
(def unfold-less (interop/react-factory UnfoldLess))
(def unfold-more (interop/react-factory UnfoldMore))
(def unsubscribe (interop/react-factory Unsubscribe))
(def update (interop/react-factory Update))
(def usb (interop/react-factory Usb))
(def verified-user (interop/react-factory VerifiedUser))
(def vertical-align-bottom (interop/react-factory VerticalAlignBottom))
(def vertical-align-center (interop/react-factory VerticalAlignCenter))
(def vertical-align-top (interop/react-factory VerticalAlignTop))
(def vertical-split (interop/react-factory VerticalSplit))
(def vibration (interop/react-factory Vibration))
(def video-call (interop/react-factory VideoCall))
(def video-label (interop/react-factory VideoLabel))
(def video-library (interop/react-factory VideoLibrary))
(def videocam (interop/react-factory Videocam))
(def videocam-off (interop/react-factory VideocamOff))
(def videogame-asset (interop/react-factory VideogameAsset))
(def view-agenda (interop/react-factory ViewAgenda))
(def view-array (interop/react-factory ViewArray))
(def view-carousel (interop/react-factory ViewCarousel))
(def view-column (interop/react-factory ViewColumn))
(def view-comfy (interop/react-factory ViewComfy))
(def view-compact (interop/react-factory ViewCompact))
(def view-day (interop/react-factory ViewDay))
(def view-headline (interop/react-factory ViewHeadline))
(def view-list (interop/react-factory ViewList))
(def view-module (interop/react-factory ViewModule))
(def view-quilt (interop/react-factory ViewQuilt))
(def view-stream (interop/react-factory ViewStream))
(def view-week (interop/react-factory ViewWeek))
(def vignette (interop/react-factory Vignette))
(def visibility (interop/react-factory Visibility))
(def visibility-off (interop/react-factory VisibilityOff))
(def voice-chat (interop/react-factory VoiceChat))
(def voice-over-off (interop/react-factory VoiceOverOff))
(def voicemail (interop/react-factory Voicemail))
(def volume-down (interop/react-factory VolumeDown))
(def volume-mute (interop/react-factory VolumeMute))
(def volume-off (interop/react-factory VolumeOff))
(def volume-up (interop/react-factory VolumeUp))
(def vpn-key (interop/react-factory VpnKey))
(def vpn-lock (interop/react-factory VpnLock))
(def wallpaper (interop/react-factory Wallpaper))
(def warning (interop/react-factory Warning))
(def watch (interop/react-factory Watch))
(def watch-later (interop/react-factory WatchLater))
(def waves (interop/react-factory Waves))
(def wb-auto (interop/react-factory WbAuto))
(def wb-cloudy (interop/react-factory WbCloudy))
(def wb-incandescent (interop/react-factory WbIncandescent))
(def wb-iridescent (interop/react-factory WbIridescent))
(def wb-sunny (interop/react-factory WbSunny))
(def wc (interop/react-factory Wc))
(def web (interop/react-factory Web))
(def web-asset (interop/react-factory WebAsset))
(def weekend (interop/react-factory Weekend))
(def whats-app (interop/react-factory WhatsApp))
(def whatshot (interop/react-factory Whatshot))
(def where-to-vote (interop/react-factory WhereToVote))
(def widgets (interop/react-factory Widgets))
(def wifi (interop/react-factory Wifi))
(def wifi-lock (interop/react-factory WifiLock))
(def wifi-off (interop/react-factory WifiOff))
(def wifi-tethering (interop/react-factory WifiTethering))
(def work (interop/react-factory Work))
(def work-off (interop/react-factory WorkOff))
(def work-outline (interop/react-factory WorkOutline))
(def wrap-text (interop/react-factory WrapText))
(def you-tube (interop/react-factory YouTube))
(def youtube-searched-for (interop/react-factory YoutubeSearchedFor))
(def zoom-in (interop/react-factory ZoomIn))
(def zoom-out (interop/react-factory ZoomOut))
(def zoom-out-map (interop/react-factory ZoomOutMap))
