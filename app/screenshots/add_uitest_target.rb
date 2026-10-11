#!/usr/bin/env ruby
# Injects a UI-test target into the Expo-prebuilt Xcode project and wires it
# into the app's shared scheme so `fastlane snapshot` can drive it.
# Idempotent: bails cleanly if the target already exists.
require 'xcodeproj'

proj_path = Dir.glob('ios/*.xcodeproj').first or abort('No .xcodeproj under ios/')
project = Xcodeproj::Project.open(proj_path)

app_target = project.targets.find { |t| t.product_type == 'com.apple.product-type.application' }
abort('No application target found') unless app_target
puts "App target: #{app_target.name}"

TEST_NAME = 'ScreenshotUITests'
if project.targets.any? { |t| t.name == TEST_NAME }
  puts 'UI test target already present — nothing to do.'
  exit 0
end

deployment = app_target.resolved_build_setting('IPHONEOS_DEPLOYMENT_TARGET', true).values.compact.first || '15.1'
test_target = project.new_target(:ui_test_bundle, TEST_NAME, :ios, deployment)

group = project.main_group.new_group(TEST_NAME, TEST_NAME)
%w[ScreenshotUITests.swift SnapshotHelper.swift].each do |f|
  ref = group.new_file(f)
  test_target.add_file_references([ref])
end

test_target.add_dependency(app_target)

test_target.build_configurations.each do |c|
  # Without an explicit PRODUCT_NAME the xctest bundle builds as ".xctest"
  # (empty basename); the arm64/x86_64 slices then both write to the same
  # path and xcodebuild aborts with "Multiple commands produce .../.xctest".
  c.build_settings['PRODUCT_NAME'] = TEST_NAME
  c.build_settings['TEST_TARGET_NAME'] = app_target.name
  c.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'com.nanoluke.tfldelayrepay.uitests'
  c.build_settings['SWIFT_VERSION'] = '5.0'
  c.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = deployment
  c.build_settings['TARGETED_DEVICE_FAMILY'] = '1'
  c.build_settings['GENERATE_INFOPLIST_FILE'] = 'YES'
  c.build_settings['CODE_SIGNING_ALLOWED'] = 'NO'
  c.build_settings['CODE_SIGN_IDENTITY'] = ''
  c.build_settings['ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES'] = 'YES'
end

project.save
puts "Added target #{TEST_NAME} (deployment #{deployment})."

# Wire the test target into the app's shared scheme.
scheme_path = Dir.glob("#{proj_path}/xcshareddata/xcschemes/*.xcscheme").first
abort('No shared scheme found — prebuild should have created one') unless scheme_path
scheme = Xcodeproj::XCScheme.new(scheme_path)
ref = Xcodeproj::XCScheme::TestAction::TestableReference.new(test_target)
scheme.test_action.add_testable(ref)
# Make sure the test bundle is built when the scheme builds for testing.
entry = Xcodeproj::XCScheme::BuildAction::Entry.new(test_target)
entry.build_for_testing = true
scheme.build_action.add_entry(entry)
scheme.save!
puts "Wired #{TEST_NAME} into scheme #{File.basename(scheme_path)}."
